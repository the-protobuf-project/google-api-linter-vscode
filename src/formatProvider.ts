import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

type FormatterKind = "buf" | "clang-format" | "simple";

/* ------------------------------------------------------------------ *
 * Temp-file strategy for `buf format`
 *
 * The old code wrote `.gapi-format-temp-<ts>.proto` INTO the user's source
 * directory on every format (including every format-on-save), then deleted it.
 * On a large repo that churns the source tree: file watchers fire, `**\/*.proto`
 * globs pick it up, and a concurrent `buf build` can read it mid-write.
 *
 * Fix: the scratch file lives in a per-session directory under os.tmpdir(), so it
 * is outside every workspace glob and watcher. Config discovery is preserved
 * EXPLICITLY instead of positionally — we locate the governing `buf.yaml` by
 * walking up from the real file and pass it via `buf format --config`, which is
 * capability-probed once per buf binary (`buf format --help`) before use and
 * simply omitted if the installed buf does not have it. Verified against buf
 * 1.72.0: `--config` exists, and formatting a file in os.tmpdir() with an
 * out-of-tree `--config` succeeds.
 *
 * The `.proto` extension is kept deliberately: `buf format` rejects any other
 * extension ("not a directory"). Being in os.tmpdir() is what makes it invisible
 * to workspace globs, not the name.
 * ------------------------------------------------------------------ */

/** Per-session scratch directory, created lazily outside the workspace. */
let sessionTempDir: string | null = null;
let tempFileCounter = 0;

const getSessionTempDir = (): string => {
	if (sessionTempDir === null || !fs.existsSync(sessionTempDir)) {
		sessionTempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gapi-format-"));
	}
	return sessionTempDir;
};

/** Cached `buf format --config` support, keyed by buf binary path. */
const configFlagSupport = new Map<string, Promise<boolean>>();

const supportsConfigFlag = (bufPath: string): Promise<boolean> => {
	let probe = configFlagSupport.get(bufPath);
	if (probe === undefined) {
		probe = new Promise<boolean>((resolve) => {
			cp.execFile(
				bufPath,
				["format", "--help"],
				{ maxBuffer: 1024 * 1024 },
				(err, stdout, stderr) => {
					const help = `${stdout ?? ""}${stderr ?? ""}`;
					resolve(
						help.length > 0 && !err ? /(^|\s)--config\b/.test(help) : false,
					);
				},
			);
		});
		configFlagSupport.set(bufPath, probe);
	}
	return probe;
};

/** Nearest `buf.yaml` at or above `startDir`, bounded by the owning workspace folder. */
const findGoverningBufConfig = (startDir: string): string | undefined => {
	const stop = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(startDir))
		?.uri.fsPath;
	let dir = path.resolve(startDir);
	for (;;) {
		const candidate = path.join(dir, "buf.yaml");
		if (fs.existsSync(candidate)) {
			return candidate;
		}
		if (stop !== undefined && dir === path.resolve(stop)) {
			return undefined;
		}
		const parent = path.dirname(dir);
		if (parent === dir) {
			return undefined;
		}
		dir = parent;
	}
};

/**
 * DocumentFormattingEditProvider for .proto files.
 * Uses gapi.formatter: buf format, clang-format, or simple built-in.
 */
export class ProtoFormatProvider
	implements vscode.DocumentFormattingEditProvider
{
	provideDocumentFormattingEdits(
		document: vscode.TextDocument,
		options: vscode.FormattingOptions,
		_token: vscode.CancellationToken,
	): vscode.ProviderResult<vscode.TextEdit[]> {
		const formatter = this.getFormatterKind();
		return this.runFormatter(document, formatter, options).then((formatted) => {
			if (formatted !== null) {
				const fullRange = new vscode.Range(
					document.positionAt(0),
					document.positionAt(document.getText().length),
				);
				return [vscode.TextEdit.replace(fullRange, formatted)];
			}
			// Never fall back to naive simpleFormat when buf/clang-format failed — it corrupts protos.
			if (formatter === "simple") {
				return this.simpleFormat(document, options);
			}
			return [];
		});
	}

	private getFormatterKind(): FormatterKind {
		const config = vscode.workspace.getConfiguration("gapi");
		const raw = config.get<string>("formatter", "buf");
		return raw === "clang-format" || raw === "simple" ? raw : "buf";
	}

	private getBufPath(): string {
		const config = vscode.workspace.getConfiguration("gapi");
		return config.get<string>("bufPath", "buf");
	}

	private async runFormatter(
		document: vscode.TextDocument,
		kind: FormatterKind,
		_options: vscode.FormattingOptions,
	): Promise<string | null> {
		if (kind === "simple") {
			return null;
		}
		if (kind === "clang-format") {
			return this.formatWithClangFormat(document);
		}
		return this.formatWithBuf(document);
	}

	/** Use clang-format with --assume-filename for Protobuf. */
	private async formatWithClangFormat(
		document: vscode.TextDocument,
	): Promise<string | null> {
		const config = vscode.workspace.getConfiguration("gapi");
		const bin = config.get<string>("clangFormatPath", "clang-format");
		const text = document.getText();
		const assumeName = path.basename(document.uri.fsPath) || "file.proto";
		return new Promise<string | null>((resolve) => {
			const child = cp.spawn(bin, [`--assume-filename=${assumeName}`], {
				stdio: ["pipe", "pipe", "pipe"],
			});
			let out = "";
			child.stdout.setEncoding("utf8");
			child.stdout.on("data", (chunk: string) => {
				out += chunk;
			});
			child.on("error", () => resolve(null));
			child.on("close", (code) => {
				resolve(code === 0 && out ? out : null);
			});
			child.stdin.end(text, "utf8");
		});
	}

	/**
	 * Always format from document content (scratch file) so we never overwrite the
	 * buffer with stale disk content. See the temp-file strategy note at the top of
	 * this file: the scratch file lives in os.tmpdir(), never in the source tree.
	 */
	private async formatWithBuf(
		document: vscode.TextDocument,
	): Promise<string | null> {
		let tempPath: string | null = null;
		try {
			const sourcePath = document.uri.fsPath;
			const sourceDir = path.dirname(sourcePath);

			// Keep the original basename so buf's error messages stay recognisable;
			// the `.proto` extension is mandatory (buf rejects anything else).
			const base =
				path
					.basename(sourcePath)
					.replace(/\.proto$/i, "")
					.replace(/[^A-Za-z0-9._-]/g, "_") || "unnamed";
			tempFileCounter += 1;
			tempPath = path.join(
				getSessionTempDir(),
				`${base}-${process.pid}-${tempFileCounter}.proto`,
			);
			fs.writeFileSync(tempPath, document.getText(), "utf8");

			const buf = this.getBufPath();
			const args = ["format", "-w"];
			const config = findGoverningBufConfig(sourceDir);
			if (config !== undefined && (await supportsConfigFlag(buf))) {
				args.push("--config", config);
			}
			args.push(tempPath);

			// Run from the config's directory (or the source directory) so anything
			// relative in that config resolves exactly as it would for a real build.
			const configDir = config !== undefined ? path.dirname(config) : sourceDir;
			const cwd = fs.existsSync(configDir) ? configDir : undefined;

			await new Promise<void>((resolve, reject) => {
				cp.execFile(buf, args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (err) => {
					if (err) {
						reject(err);
					} else {
						resolve();
					}
				});
			});
			return fs.readFileSync(tempPath, "utf8");
		} catch {
			return null;
		} finally {
			if (tempPath !== null && fs.existsSync(tempPath)) {
				try {
					fs.unlinkSync(tempPath);
				} catch {}
			}
		}
	}

	/** Simple formatter: indent per brace level, trim trailing whitespace, single newline at EOF. */
	private simpleFormat(
		document: vscode.TextDocument,
		options: vscode.FormattingOptions,
	): vscode.TextEdit[] {
		const lines = document.getText().split(/\r?\n/);
		const indent = options.insertSpaces ? " ".repeat(options.tabSize) : "\t";
		let depth = 0;
		const out: string[] = [];
		for (const line of lines) {
			const trimmed = line.trim();
			if (trimmed === "") {
				out.push("");
				continue;
			}
			const openCount = (line.match(/\{/g) ?? []).length;
			const closeCount = (line.match(/\}/g) ?? []).length;
			out.push(indent.repeat(depth) + trimmed);
			depth = Math.max(0, depth + openCount - closeCount);
		}
		let result = out.join("\n").trimEnd();
		if (result && !result.endsWith("\n")) {
			result += "\n";
		}
		const fullRange = new vscode.Range(
			document.positionAt(0),
			document.positionAt(document.getText().length),
		);
		return [vscode.TextEdit.replace(fullRange, result)];
	}
}

const sharedFormatProvider = new ProtoFormatProvider();

export function registerFormatProvider(
	selector: vscode.DocumentSelector,
): vscode.Disposable {
	return vscode.languages.registerDocumentFormattingEditProvider(
		selector,
		sharedFormatProvider,
	);
}

/**
 * Returns formatting edits for a proto document (used for format-on-save).
 * Uses the same logic as the document formatter (no destructive simple fallback when formatter is buf/clang-format).
 */
export async function getFormatEdits(
	document: vscode.TextDocument,
	options?: vscode.FormattingOptions,
): Promise<vscode.TextEdit[]> {
	const opts = options ?? {
		tabSize: 2,
		insertSpaces: true,
	};
	const result = await sharedFormatProvider.provideDocumentFormattingEdits(
		document,
		opts,
		new vscode.CancellationTokenSource().token,
	);
	return result ?? [];
}
