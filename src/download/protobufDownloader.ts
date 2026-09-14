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
 * Handles downloading and managing protobuf protos
 */
export class ProtobufDownloader {
	private readonly gapiDir: string;
	private readonly protobufDir: string;
	private readonly protobufMetadataPath: string;
	private outputChannel: AppendLineLogger;

	constructor(outputChannel: AppendLineLogger) {
		this.outputChannel = outputChannel;
		const homeDir = os.homedir();
		this.gapiDir = path.join(homeDir, ".gapi");
		this.protobufDir = path.join(this.gapiDir, "protobuf");
		this.protobufMetadataPath = path.join(
			this.gapiDir,
			"protobuf-metadata.json",
		);
	}

	/**
	 * Gets the protobuf commit hash
	 */
	public async getProtobufCommit(): Promise<string> {
		try {
			const metadata = await readFile(this.protobufMetadataPath, "utf-8");
			const data = JSON.parse(metadata);
			return data.commit || "not downloaded";
		} catch {
			return "not downloaded";
		}
	}

	/**
	 * Gets the protobuf directory path
	 * Protos are in the src subdirectory of the downloaded repository
	 */
	public getProtobufDir(): string {
		return path.join(this.protobufDir, "src");
	}

	/**
	 * Ensures protobuf protos are downloaded
	 */
	public async ensureProtobuf(): Promise<void> {
		try {
			this.outputChannel.appendLine("Checking protobuf...");
			const shouldDownload = await this.shouldDownloadProtobuf();
			this.outputChannel.appendLine(
				`Should download protobuf: ${shouldDownload}`,
			);

			if (!shouldDownload) {
				this.outputChannel.appendLine("protobuf already up to date");
				return;
			}

			this.outputChannel.appendLine("Downloading protobuf from GitHub...");

			const zipPath = path.join(this.gapiDir, "protobuf.zip");
			const extractPath = path.join(this.gapiDir, "protobuf-temp");

			await this.downloadProtobufZip(zipPath);
			this.outputChannel.appendLine("Download complete, extracting...");

			await this.extractProtobuf(zipPath, extractPath);
			this.outputChannel.appendLine("Extraction complete");

			try {
				fs.unlinkSync(zipPath);
			} catch {
				// ignore
			}

			await this.updateProtobufMetadata();
			this.outputChannel.appendLine("protobuf downloaded successfully");
		} catch (error) {
			this.outputChannel.appendLine(`Failed to download protobuf: ${error}`);
			throw error;
		}
	}

	private async shouldDownloadProtobuf(): Promise<boolean> {
		if (!fs.existsSync(this.protobufDir)) {
			return true;
		}

		try {
			const metadataContent = await readFile(
				this.protobufMetadataPath,
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

	private async downloadProtobufZip(zipPath: string): Promise<void> {
		const apiUrl =
			"https://api.github.com/repos/protocolbuffers/protobuf/releases/latest";
		const releaseInfo = (await this.fetchJson(apiUrl)) as { tag_name: string };
		const version = releaseInfo.tag_name;

		this.outputChannel.appendLine(`Downloading protobuf ${version}...`);

		const url = `https://github.com/protocolbuffers/protobuf/archive/refs/tags/${version}.zip`;
		const file = createWriteStream(zipPath);

		await new Promise<void>((resolve, reject) => {
			const follow = (currentUrl: string, hopsLeft: number) => {
				if (hopsLeft <= 0) {
					file.close();
					reject(new Error("Too many redirects downloading protobuf"));
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
								response.resume(); // drain before following
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

	private async fetchJson<T = unknown>(url: string): Promise<T> {
		return new Promise((resolve, reject) => {
			https
				.get(
					url,
					{
						headers: {
							"User-Agent": "vscode-protobuf-aip-linter",
						},
					},
					(response) => {
						let data = "";
						response.on("data", (chunk) => (data += chunk));
						response.on("end", () => {
							try {
								resolve(JSON.parse(data));
							} catch (error) {
								reject(error);
							}
						});
					},
				)
				.on("error", reject);
		});
	}

	private async extractProtobuf(
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
							// Find the extracted directory (it will be protobuf-vX.X.X format)
							const extractedDirs = fs.readdirSync(extractPath);
							const protobufDir = extractedDirs.find((dir) =>
								dir.startsWith("protobuf-"),
							);

							if (!protobufDir) {
								throw new Error("Could not find extracted protobuf directory");
							}

							const extractedDir = path.join(extractPath, protobufDir);

							if (fs.existsSync(this.protobufDir)) {
								fs.rmSync(this.protobufDir, { recursive: true, force: true });
							}

							fs.renameSync(extractedDir, this.protobufDir);
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
				reject(new Error(`Failed to extract protobuf: ${error}`));
			}
		});
	}

	private async updateProtobufMetadata(): Promise<void> {
		try {
			const apiUrl =
				"https://api.github.com/repos/protocolbuffers/protobuf/releases/latest";
			const releaseInfo = await this.fetchJson<{ tag_name: string }>(apiUrl);
			const version = releaseInfo.tag_name;

			const metadata = {
				lastChecked: Date.now(),
				version: version,
				source: "https://github.com/protocolbuffers/protobuf",
				path: this.protobufDir,
			};
			await writeFile(
				this.protobufMetadataPath,
				JSON.stringify(metadata, null, 2),
			);
		} catch (_error) {
			// Fallback metadata if API call fails
			const metadata = {
				lastChecked: Date.now(),
				version: "latest",
				source: "https://github.com/protocolbuffers/protobuf",
				path: this.protobufDir,
			};
			await writeFile(
				this.protobufMetadataPath,
				JSON.stringify(metadata, null, 2),
			);
		}
	}
}
