/**
 * The mutating half of dependency management: editing `buf.yaml` and running
 * the `buf` CLI.
 *
 * Kept apart from the read-only model in `src/deps` because the risks differ.
 * Reading is cheap and safe to do on a timer; these operations write a file the
 * user commits and spawn a process that reaches the network, so each one is
 * explicitly invoked, reports progress, and never runs on activation.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as vscode from "vscode";
import { parseDocument, YAMLSeq } from "yaml";

const execFileAsync = promisify(execFile);

/** `buf dep update` can pull a large module graph; `buf generate` compiles. */
const COMMAND_TIMEOUT_MS = 180_000;

/** What a `buf` invocation produced. */
export interface CommandResult {
	readonly ok: boolean;
	readonly stdout: string;
	readonly stderr: string;
}

/** The configured `buf` binary, honouring `gapi.bufPath`. */
export function bufBinary(): string {
	return (
		vscode.workspace.getConfiguration("gapi").get<string>("bufPath") || "buf"
	);
}

/**
 * Run one `buf` subcommand in a directory.
 *
 * Never throws on a non-zero exit: a failing `buf generate` is an ordinary
 * outcome the caller must show the user, not an exception to unwind through.
 *
 * @param args - Arguments after the binary name
 * @param cwd - Working directory, normally a module root
 * @param log - Output channel to echo the invocation into
 * @returns Exit status and captured output
 */
export async function runBuf(
	args: readonly string[],
	cwd: string,
	log?: vscode.OutputChannel,
): Promise<CommandResult> {
	const binary = bufBinary();
	log?.appendLine(`[buf] ${binary} ${args.join(" ")} (in ${cwd})`);
	try {
		const { stdout, stderr } = await execFileAsync(binary, [...args], {
			cwd,
			timeout: COMMAND_TIMEOUT_MS,
			maxBuffer: 8 * 1024 * 1024,
		});
		return { ok: true, stdout, stderr };
	} catch (error) {
		const shaped = error as {
			stdout?: string;
			stderr?: string;
			message?: string;
		};
		const stderr = shaped.stderr ?? shaped.message ?? String(error);
		log?.appendLine(`[buf] failed: ${stderr.trim()}`);
		return { ok: false, stdout: shaped.stdout ?? "", stderr };
	}
}

/**
 * Add a module to a `buf.yaml`'s `deps:` list.
 *
 * `buf dep` has no `add` subcommand — only `graph`, `prune` and `update` — so
 * the file is edited here and `buf dep update` is left to resolve the commit
 * and digest into `buf.lock`.
 *
 * The edit goes through `parseDocument` rather than a string append because
 * `buf.yaml` is a file people hand-write and comment. Re-serialising a plain
 * `parse` result would silently delete every comment in it.
 *
 * @param bufYamlPath - Absolute path of the `buf.yaml` to edit
 * @param moduleRef - Module reference, e.g. `buf.build/acme/petapis`
 * @returns Whether the file changed, and why not when it did not
 */
export async function addDependency(
	bufYamlPath: string,
	moduleRef: string,
): Promise<{ changed: boolean; reason?: string }> {
	const uri = vscode.Uri.file(bufYamlPath);
	let text: string;
	try {
		text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString(
			"utf8",
		);
	} catch {
		return { changed: false, reason: `Could not read ${bufYamlPath}` };
	}

	const doc = parseDocument(text);
	if (doc.errors.length > 0) {
		// Writing to a file we could not fully parse risks destroying it.
		return {
			changed: false,
			reason: `${bufYamlPath} has YAML errors; fix them before adding a dependency`,
		};
	}

	const existing = doc.get("deps");
	if (existing instanceof YAMLSeq) {
		const already = existing.items.some((item) => {
			const value = (item as { value?: unknown }).value ?? item;
			return String(value) === moduleRef;
		});
		if (already) {
			return { changed: false, reason: `${moduleRef} is already a dependency` };
		}
		existing.add(moduleRef);
	} else {
		doc.set("deps", [moduleRef]);
	}

	const updated = doc.toString({ lineWidth: 0 });
	await vscode.workspace.fs.writeFile(uri, Buffer.from(updated, "utf8"));
	return { changed: true };
}

/**
 * The YAML that {@link addDependency} would write, without writing it.
 *
 * The Registry panel shows this before the user commits to the change: the file
 * is version-controlled and hand-maintained, so the edit should not be a
 * surprise.
 *
 * @param currentDeps - `deps:` as it stands
 * @param moduleRef - The module that would be added
 * @returns The rendered `deps:` block with the new entry last
 */
export function previewDependencyEdit(
	currentDeps: readonly string[],
	moduleRef: string,
): string {
	const lines = ["deps:"];
	for (const dep of currentDeps) {
		lines.push(`  - ${dep}`);
	}
	lines.push(`  - ${moduleRef}`);
	return lines.join("\n");
}

/** Run `buf dep update` in a module root, pinning `buf.lock`. */
export async function updateDependencies(
	root: string,
	log?: vscode.OutputChannel,
): Promise<CommandResult> {
	return runBuf(["dep", "update"], root, log);
}

/** Run `buf generate` in a module root. */
export async function generate(
	root: string,
	log?: vscode.OutputChannel,
): Promise<CommandResult> {
	return runBuf(["generate"], root, log);
}
