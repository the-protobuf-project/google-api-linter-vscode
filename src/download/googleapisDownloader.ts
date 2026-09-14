import * as cp from "node:child_process";
import * as fs from "node:fs";
import { createWriteStream } from "node:fs";
import https from "node:https";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import type { AppendLineLogger } from "../types";

const exec = promisify(cp.exec);
const writeFile = promisify(fs.writeFile);
const readFile = promisify(fs.readFile);

/**
 * Handles downloading and managing googleapis protos
 */
export class GoogleapisDownloader {
	private readonly gapiDir: string;
	private readonly googleapisDir: string;
	private readonly googleapisMetadataPath: string;
	private outputChannel: AppendLineLogger;

	constructor(outputChannel: AppendLineLogger) {
		this.outputChannel = outputChannel;
		const homeDir = os.homedir();
		this.gapiDir = path.join(homeDir, ".gapi");
		this.googleapisDir = path.join(this.gapiDir, "googleapis");
		this.googleapisMetadataPath = path.join(
			this.gapiDir,
			"googleapis-metadata.json",
		);
	}

	/**
	 * Gets the googleapis commit hash
	 */
	public async getGoogleapisCommit(): Promise<string> {
		try {
			const metadata = await readFile(this.googleapisMetadataPath, "utf-8");
			const data = JSON.parse(metadata);
			return data.commit || "not downloaded";
		} catch {
			return "not downloaded";
		}
	}

	/**
	 * Gets the googleapis directory path
	 */
	public getGoogleapisDir(): string {
		return this.googleapisDir;
	}

	/**
	 * Ensures googleapis protos are downloaded
	 */
	public async ensureGoogleapis(): Promise<void> {
		try {
			this.outputChannel.appendLine("Checking googleapis...");
			const shouldDownload = await this.shouldDownloadGoogleapis();
			this.outputChannel.appendLine(
				`Should download googleapis: ${shouldDownload}`,
			);

			if (!shouldDownload) {
				this.outputChannel.appendLine("googleapis already up to date");
				return;
			}

			this.outputChannel.appendLine("Downloading googleapis from GitHub...");

			const zipPath = path.join(this.gapiDir, "googleapis.zip");
			const extractPath = path.join(this.gapiDir, "googleapis-temp");

			await this.downloadGoogleapisZip(zipPath);
			this.outputChannel.appendLine("Download complete, extracting...");

			await this.extractGoogleapis(zipPath, extractPath);
			this.outputChannel.appendLine("Extraction complete");

			try {
				fs.unlinkSync(zipPath);
			} catch {
				// ignore
			}

			await this.updateGoogleapisMetadata();
			this.outputChannel.appendLine("googleapis downloaded successfully");
		} catch (error) {
			this.outputChannel.appendLine(`Failed to download googleapis: ${error}`);
			throw error;
		}
	}

	private async shouldDownloadGoogleapis(): Promise<boolean> {
		if (!fs.existsSync(this.googleapisDir)) {
			return true;
		}

		try {
			const metadataContent = await readFile(
				this.googleapisMetadataPath,
				"utf-8",
			);
			const metadata = JSON.parse(metadataContent);
			const now = Date.now();
			const thirtyDays = 30 * 24 * 60 * 60 * 1000;
			return now - metadata.lastChecked > thirtyDays;
		} catch {
			return true;
		}
	}

	private async downloadGoogleapisZip(zipPath: string): Promise<void> {
		return new Promise((resolve, reject) => {
			const url =
				"https://github.com/googleapis/googleapis/archive/refs/heads/master.zip";
			const file = createWriteStream(zipPath);

			const follow = (currentUrl: string, hopsLeft: number) => {
				if (hopsLeft <= 0) {
					file.close();
					reject(new Error("Too many redirects downloading googleapis"));
					return;
				}
				https
					.get(
						currentUrl,
						{ headers: { "User-Agent": "vscode-protobuf-aip-linter" } },
						(response) => {
							if (
								response.statusCode === 301 ||
								response.statusCode === 302 ||
								response.statusCode === 307 ||
								response.statusCode === 308
							) {
								const location = response.headers.location;
								if (!location) {
									reject(new Error("Redirect with no Location header"));
									return;
								}
								response.resume(); // drain response before following
								follow(location, hopsLeft - 1);
								return;
							}
							response.pipe(file);
							file.on("finish", () => {
								file.close();
								resolve();
							});
						},
					)
					.on("error", (error) => {
						fs.unlinkSync(zipPath);
						reject(error);
					});
			};
			follow(url, 10);
		});
	}

	private async extractGoogleapis(
		zipPath: string,
		extractPath: string,
	): Promise<void> {
		return new Promise((resolve, reject) => {
			try {
				if (fs.existsSync(extractPath)) {
					fs.rmSync(extractPath, { recursive: true, force: true });
				}

				fs.mkdirSync(extractPath, { recursive: true });

				exec(`unzip -q "${zipPath}" -d "${extractPath}"`)
					.then(() => {
						try {
							const extractedDir = path.join(extractPath, "googleapis-master");

							if (fs.existsSync(this.googleapisDir)) {
								fs.rmSync(this.googleapisDir, {
									recursive: true,
									force: true,
								});
							}

							fs.renameSync(extractedDir, this.googleapisDir);
							fs.rmSync(extractPath, { recursive: true, force: true });

							resolve();
						} catch (error) {
							reject(new Error(`Failed to move extracted files: ${error}`));
						}
					})
					.catch((error: Error) => {
						reject(new Error(`Failed to extract zip: ${error}`));
					});
			} catch (error) {
				reject(new Error(`Failed to extract googleapis: ${error}`));
			}
		});
	}

	private async updateGoogleapisMetadata(): Promise<void> {
		const metadata = {
			lastChecked: Date.now(),
			commit: "master",
			source: "https://github.com/googleapis/googleapis",
			path: this.googleapisDir,
		};
		await writeFile(
			this.googleapisMetadataPath,
			JSON.stringify(metadata, null, 2),
		);
	}
}
