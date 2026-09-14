import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";
import type { AppendLineLogger, BinaryMetadata } from "../types";
import { downloadFile, fetchJson } from "../utils/httpClient";
import { getArch, getPlatform } from "../utils/platformUtils";

const exec = promisify(cp.exec);
const mkdir = promisify(fs.mkdir);
const writeFile = promisify(fs.writeFile);
const readFile = promisify(fs.readFile);
const chmod = promisify(fs.chmod);

const GITHUB_LATEST_RELEASE =
	"https://api.github.com/repos/googleapis/api-linter/releases/latest";

/**
 * The release history, newest first. Only consulted when the newest tag turns
 * out to have nothing for this machine; see `resolveRelease`.
 */
const GITHUB_RELEASE_HISTORY =
	"https://api.github.com/repos/googleapis/api-linter/releases?per_page=20";

/**
 * What the release archives unpack to. The Windows build ships
 * `api-linter.exe`, every other platform a bare `api-linter`. Installing under
 * any other name means the post-extraction check never finds the binary.
 */
const BINARY_NAME = os.platform() === "win32" ? "api-linter.exe" : "api-linter";

type GitHubReleaseAsset = {
	name: string;
	browser_download_url: string;
};

type GitHubRelease = {
	tag_name: string;
	draft?: boolean;
	prerelease?: boolean;
	assets: GitHubReleaseAsset[];
};

/** A release paired with the asset that matches this machine. */
type ResolvedRelease = {
	release: GitHubRelease;
	asset: GitHubReleaseAsset;
};

/** Renders a release's assets for a log line or an error message. */
const describeAssets = (assets: GitHubReleaseAsset[]): string =>
	assets.length === 0 ? "no assets" : assets.map((a) => a.name).join(", ");

/**
 * Handles downloading and managing the api-linter binary
 */
export class ApiLinterDownloader {
	private readonly GAPI_DIR: string;
	private readonly BINARY_PATH: string;
	private readonly METADATA_PATH: string;
	private outputChannel: AppendLineLogger;

	constructor(outputChannel: AppendLineLogger) {
		this.outputChannel = outputChannel;
		const homeDir = os.homedir();
		this.GAPI_DIR = path.join(homeDir, ".gapi");
		this.BINARY_PATH = path.join(this.GAPI_DIR, BINARY_NAME);
		this.METADATA_PATH = path.join(this.GAPI_DIR, "metadata.json");
	}

	/**
	 * Gets the installed api-linter version
	 */
	public async getBinaryVersion(): Promise<string> {
		try {
			const metadata = await readFile(this.METADATA_PATH, "utf-8");
			const data = JSON.parse(metadata);
			return data.version || "unknown";
		} catch {
			return "unknown";
		}
	}

	/**
	 * Ensures the api-linter binary is available and up-to-date
	 */
	public async ensureBinary(): Promise<string> {
		await this.ensureDirectory();

		const customBinaryPath = this.getCustomBinaryPath();
		if (customBinaryPath) {
			this.outputChannel.appendLine(
				`Using custom binary path: ${customBinaryPath}`,
			);
			return customBinaryPath;
		}

		if (await this.binaryExists()) {
			if (await this.shouldCheckForUpdate()) {
				this.outputChannel.appendLine("Checking for updates...");
				await this.checkAndUpdate();
			}
			return this.BINARY_PATH;
		}

		this.outputChannel.appendLine("Binary not found. Downloading...");
		await this.downloadBinary();
		return this.BINARY_PATH;
	}

	private getCustomBinaryPath(): string | null {
		const config = vscode.workspace.getConfiguration("gapi");
		const customPath = config.get<string>("binaryPath");
		return customPath && customPath !== "api-linter" ? customPath : null;
	}

	private async ensureDirectory(): Promise<void> {
		if (!fs.existsSync(this.GAPI_DIR)) {
			await mkdir(this.GAPI_DIR, { recursive: true });
		}
	}

	private async binaryExists(): Promise<boolean> {
		return fs.existsSync(this.BINARY_PATH);
	}

	private async shouldCheckForUpdate(): Promise<boolean> {
		try {
			const metadata = await readFile(this.METADATA_PATH, "utf-8");
			const data: BinaryMetadata = JSON.parse(metadata);
			const now = Date.now();
			const oneDayInMs = 24 * 60 * 60 * 1000;
			return now - data.lastChecked > oneDayInMs;
		} catch {
			return true;
		}
	}

	public async checkAndUpdate(): Promise<void> {
		try {
			const latestVersion = await this.getLatestVersion();
			const currentVersion = await this.getCurrentVersion();

			if (latestVersion !== currentVersion) {
				const selection = await vscode.window.showInformationMessage(
					`New version of api-linter available: ${latestVersion} (current: ${currentVersion})`,
					"Update Now",
					"Later",
				);

				if (selection === "Update Now") {
					await this.downloadBinary();
					vscode.window.showInformationMessage(
						`api-linter updated to ${latestVersion}`,
					);
				}
			}

			await this.updateMetadata(currentVersion);
		} catch (error) {
			this.outputChannel.appendLine(`Failed to check for updates: ${error}`);
		}
	}

	private async getLatestVersion(): Promise<string> {
		const { release } = await this.resolveRelease();
		return release.tag_name;
	}

	private async getCurrentVersion(): Promise<string> {
		try {
			const metadata = await readFile(this.METADATA_PATH, "utf-8");
			const data: BinaryMetadata = JSON.parse(metadata);
			return data.version;
		} catch {
			return "unknown";
		}
	}

	public async downloadBinary(): Promise<void> {
		try {
			this.outputChannel.appendLine("Downloading api-linter binary...");
			// `ensureBinary` gets here with the directory already made, but an
			// update check after a wiped `.gapi` does not.
			await this.ensureDirectory();

			const { release, asset } = await this.resolveRelease();
			const version = release.tag_name;
			this.outputChannel.appendLine(`Installing version: ${version}`);

			const downloadUrl = asset.browser_download_url;
			this.outputChannel.appendLine(`Downloading from: ${downloadUrl}`);

			const tarPath = path.join(this.GAPI_DIR, "api-linter.tar.gz");

			await downloadFile(downloadUrl, tarPath, fs);
			this.outputChannel.appendLine("Download complete. Extracting...");

			await this.extractBinary(tarPath);
			await this.updateMetadata(version);
			this.outputChannel.appendLine(
				`Binary downloaded and installed successfully at ${this.BINARY_PATH}`,
			);
		} catch (error) {
			this.outputChannel.appendLine(`Failed to download binary: ${error}`);
			throw error;
		}
	}

	/**
	 * Finds the newest release that actually ships a build for this machine.
	 *
	 * Upstream tags do not reliably carry a full set of assets. v2.4.0, for one,
	 * published a single `api-linter.tar.gz` containing nothing but the Windows
	 * executable, which left every macOS and Linux user staring at "No
	 * compatible binary found". Reading `releases/latest` and stopping there
	 * turns any such slip on Google's side into a hard failure here, so when the
	 * newest tag has nothing for us we walk back through the release history for
	 * one that does. An older linter is a far better outcome than no linter.
	 */
	private async resolveRelease(): Promise<ResolvedRelease> {
		const platform = getPlatform();
		const arch = getArch();

		const latest = (await fetchJson(GITHUB_LATEST_RELEASE)) as GitHubRelease;
		const latestAsset = this.findAssetForPlatform(latest.assets);
		if (latestAsset) {
			return { release: latest, asset: latestAsset };
		}

		this.outputChannel.appendLine(
			`Release ${latest.tag_name} ships no ${platform}-${arch} build (assets: ${describeAssets(latest.assets)}). Searching earlier releases...`,
		);

		const history = (await fetchJson(
			GITHUB_RELEASE_HISTORY,
		)) as GitHubRelease[];
		for (const release of history) {
			// Drafts and pre-releases are not what `releases/latest` would have
			// offered, so they are not what a fallback should silently install.
			if (release.draft || release.prerelease) {
				continue;
			}
			const asset = this.findAssetForPlatform(release.assets);
			if (asset) {
				this.outputChannel.appendLine(
					`Falling back to ${release.tag_name}, the newest release with a ${platform}-${arch} build.`,
				);
				return { release, asset };
			}
		}

		throw new Error(
			`No api-linter build for ${platform}-${arch} in ${latest.tag_name} or the ${history.length} releases before it. ` +
				`${latest.tag_name} published: ${describeAssets(latest.assets)}. ` +
				'Point the "gapi.binaryPath" setting at a locally installed api-linter to work around this.',
		);
	}

	private findAssetForPlatform(
		assets: GitHubReleaseAsset[],
	): GitHubReleaseAsset | undefined {
		const platform = getPlatform();
		const arch = getArch();
		// Asset name includes version: api-linter-2.3.1-darwin-arm64.tar.gz
		const assetPattern = `${platform}-${arch}.tar.gz`;
		return assets.find((asset) => asset.name.includes(assetPattern));
	}

	private async extractBinary(tarPath: string): Promise<void> {
		try {
			await exec(`tar -xzf "${tarPath}" -C "${this.GAPI_DIR}"`);
		} finally {
			// Leaving a 10MB archive behind on a failed extract just means the
			// next attempt starts from a dirtier directory.
			fs.rmSync(tarPath, { force: true });
		}

		if (!fs.existsSync(this.BINARY_PATH)) {
			throw new Error(
				`Archive did not contain ${BINARY_NAME}; nothing was installed at ${this.BINARY_PATH}`,
			);
		}

		await chmod(this.BINARY_PATH, "755");
	}

	private async updateMetadata(version: string): Promise<void> {
		const metadata: BinaryMetadata = {
			version,
			lastChecked: Date.now(),
			path: this.BINARY_PATH,
		};
		await writeFile(this.METADATA_PATH, JSON.stringify(metadata, null, 2));
	}
}
