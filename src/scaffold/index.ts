/**
 * Writing the starter project and the CI workflow into a workspace.
 *
 * Both commands share one rule: nothing already on disk is overwritten without
 * being asked about by name. A scaffold that silently replaces a `buf.yaml`
 * someone has been editing is worse than one that refuses.
 */

import * as path from "node:path";
import * as vscode from "vscode";
import {
	ciWorkflow,
	packageDirectory,
	type ScaffoldFile,
	starterFiles,
} from "./templates";

/** True when the path exists, by any type. */
async function exists(uri: vscode.Uri): Promise<boolean> {
	try {
		await vscode.workspace.fs.stat(uri);
		return true;
	} catch {
		return false;
	}
}

/**
 * Writes files, skipping any that exist unless the user allows replacing them.
 *
 * @param root - Directory the paths are relative to
 * @param files - What to write
 * @returns The files actually written, and those left alone
 */
async function writeFiles(
	root: vscode.Uri,
	files: readonly ScaffoldFile[],
): Promise<{ written: string[]; skipped: string[] }> {
	const present: ScaffoldFile[] = [];
	for (const file of files) {
		if (await exists(vscode.Uri.joinPath(root, ...file.path.split("/")))) {
			present.push(file);
		}
	}

	let overwrite = false;
	if (present.length > 0) {
		const names = present.map((f) => f.path).join(", ");
		const choice = await vscode.window.showWarningMessage(
			`${present.length} file(s) already exist: ${names}`,
			{ modal: true },
			"Keep existing",
			"Overwrite",
		);
		if (choice === undefined) {
			return { written: [], skipped: files.map((f) => f.path) };
		}
		overwrite = choice === "Overwrite";
	}

	const existing = new Set(present.map((f) => f.path));
	const written: string[] = [];
	const skipped: string[] = [];
	for (const file of files) {
		if (existing.has(file.path) && !overwrite) {
			skipped.push(file.path);
			continue;
		}
		const target = vscode.Uri.joinPath(root, ...file.path.split("/"));
		await vscode.workspace.fs.writeFile(
			target,
			Buffer.from(file.contents, "utf8"),
		);
		written.push(file.path);
	}
	return { written, skipped };
}

/** The folder to scaffold into, asking when the workspace has several. */
async function targetFolder(): Promise<vscode.Uri | undefined> {
	const folders = vscode.workspace.workspaceFolders ?? [];
	if (folders.length === 0) {
		void vscode.window.showWarningMessage(
			"Open a folder first — there is nowhere to write to.",
		);
		return undefined;
	}
	if (folders.length === 1) {
		return folders[0].uri;
	}
	const picked = await vscode.window.showQuickPick(
		folders.map((folder) => ({ label: folder.name, uri: folder.uri })),
		{ title: "Which folder?" },
	);
	return picked?.uri;
}

/**
 * Adds the GitHub Actions workflow that lints protos on push and pull request.
 */
export async function setupGithubCi(): Promise<void> {
	const root = await targetFolder();
	if (!root) {
		return;
	}

	// The action needs the directory holding `buf.yaml`, since that is what it
	// exports dependencies from. Finding it beats asking.
	const found = await vscode.workspace.findFiles(
		"**/buf.yaml",
		"**/{node_modules,.git}/**",
		8,
	);
	let protoDir = ".";
	if (found.length > 0) {
		const relative = path
			.relative(root.fsPath, path.dirname(found[0].fsPath))
			.split(path.sep)
			.join("/");
		protoDir = relative === "" ? "." : relative;
	}

	const { written, skipped } = await writeFiles(root, [ciWorkflow(protoDir)]);
	if (written.length === 0) {
		if (skipped.length > 0) {
			void vscode.window.showInformationMessage("Kept the existing workflow.");
		}
		return;
	}

	const file = vscode.Uri.joinPath(
		root,
		".github",
		"workflows",
		"proto-lint.yml",
	);
	const choice = await vscode.window.showInformationMessage(
		`Added .github/workflows/proto-lint.yml${
			protoDir === "." ? "" : ` for ${protoDir}`
		}.`,
		"Open",
	);
	if (choice === "Open") {
		await vscode.window.showTextDocument(
			await vscode.workspace.openTextDocument(file),
		);
	}
}

/**
 * Scaffolds a working AIP-compliant Todo API.
 *
 * The generated protos lint clean, which is the point: the first thing the
 * reader sees is a green workspace, so anything reported afterwards is
 * something they changed.
 */
export async function createStarterProject(): Promise<void> {
	const root = await targetFolder();
	if (!root) {
		return;
	}

	const packageName = await vscode.window.showInputBox({
		title: "Proto package",
		prompt: "Package for the generated API. The directory will mirror it.",
		value: "acme.todo.v1",
		validateInput: (value) =>
			/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*\.v[0-9]+[a-z0-9]*$/.test(
				value.trim(),
			)
				? undefined
				: "Lowercase, dot-separated, ending in a version — e.g. acme.todo.v1",
	});
	if (!packageName) {
		return;
	}

	const moduleName = await vscode.window.showInputBox({
		title: "Buf module name (optional)",
		prompt: "Leave empty to skip. Used as the module's name in buf.yaml.",
		placeHolder: "buf.build/acme/todo",
	});
	// An empty box and a cancelled box both mean "no name"; only cancelling
	// the package prompt above aborts the command.

	const withCi = await vscode.window.showQuickPick(
		[
			{ label: "Yes", description: "Lint on every push and pull request" },
			{ label: "No", description: "Just the protos and buf config" },
		],
		{ title: "Add a GitHub Actions workflow?" },
	);
	if (!withCi) {
		return;
	}

	const trimmed = packageName.trim();
	const files = starterFiles({
		packageName: trimmed,
		moduleName: moduleName?.trim() || undefined,
		withCi: withCi.label === "Yes",
	});

	const { written } = await writeFiles(root, files);
	if (written.length === 0) {
		return;
	}

	const service = vscode.Uri.joinPath(
		root,
		...`${packageDirectory(trimmed)}/todo_service.proto`.split("/"),
	);
	if (await exists(service)) {
		await vscode.window.showTextDocument(
			await vscode.workspace.openTextDocument(service),
		);
	}

	const choice = await vscode.window.showInformationMessage(
		`Created a Todo API in ${packageDirectory(trimmed)}. It lints clean as written.`,
		"Lint it",
	);
	if (choice === "Lint it") {
		await vscode.commands.executeCommand("googleApiLinter.lintWorkspace");
	}
}
