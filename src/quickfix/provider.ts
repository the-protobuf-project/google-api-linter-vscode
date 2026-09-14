/**
 * Lightbulb fixes for `api-linter` findings.
 *
 * The linter states the fix in most of its messages, so the editor can offer to
 * write it rather than leaving the reader to translate prose into a schema
 * edit. `rules.ts` decides what to write, `edits.ts` decides where; this turns
 * the pair into code actions and a fix-all.
 */

import * as vscode from "vscode";
import { DIAGNOSTIC_SOURCE } from "../constants";
import {
	applyChanges,
	changeFor,
	type TextChange,
	withoutCollisions,
} from "./edits";
import { type FixContext, fixTitle, intendedFix } from "./rules";

/** Command that applies every unambiguous fix in the active file. */
export const FIX_ALL_COMMAND = "googleApiLinter.fixAllInFile";

/** The rule id carried on a diagnostic's `code`. */
function ruleIdOf(diagnostic: vscode.Diagnostic): string | undefined {
	const code = diagnostic.code;
	if (code && typeof code === "object" && "value" in code) {
		return String((code as { value: string | number }).value);
	}
	return typeof code === "string" ? code : undefined;
}

/** True when this extension published the finding. */
function isOurs(diagnostic: vscode.Diagnostic): boolean {
	return diagnostic.source === DIAGNOSTIC_SOURCE;
}

/**
 * What the file supplies that a linter message does not.
 *
 * The package and file name are needed for `java_package` and
 * `java_outer_classname`, and the declared `singular` is needed before a
 * plural can be derived from it — without which that fix declines rather than
 * guessing at an irregular noun.
 */
function contextFor(lines: readonly string[], fileName: string): FixContext {
	const packageName = /^\s*package\s+([\w.]+)\s*;/m.exec(lines.join("\n"))?.[1];
	const stem = fileName
		.replace(/\.proto$/, "")
		.split(/[/\\]/)
		.pop();
	const singular = /^\s*singular:\s*"([^"]+)"/m.exec(lines.join("\n"))?.[1];
	return {
		packageName,
		fileStem: stem,
		resourceSingular: singular,
	};
}

/** One finding paired with the change that resolves it. */
interface Fixable {
	readonly diagnostic: vscode.Diagnostic;
	readonly change: TextChange;
	readonly title: string;
}

/**
 * Every finding in a document that can be fixed without guessing.
 *
 * @param document - The proto being edited
 * @param diagnostics - Findings on it
 * @returns Fixable findings, in document order
 */
export function fixableIn(
	document: vscode.TextDocument,
	diagnostics: readonly vscode.Diagnostic[],
): readonly Fixable[] {
	const lines = document.getText().split(/\r?\n/);
	const context = contextFor(lines, document.fileName);
	const out: Fixable[] = [];

	for (const diagnostic of diagnostics) {
		if (!isOurs(diagnostic)) {
			continue;
		}
		const ruleId = ruleIdOf(diagnostic);
		if (!ruleId) {
			continue;
		}
		const fix = intendedFix(ruleId, diagnostic.message, context);
		if (!fix) {
			continue;
		}
		const change = changeFor(lines, fix, diagnostic.range.start.line);
		if (!change) {
			continue;
		}
		out.push({ diagnostic, change, title: fixTitle(fix) });
	}
	return out;
}

/** A `WorkspaceEdit` applying one change to a document. */
function editFor(
	document: vscode.TextDocument,
	change: TextChange,
): vscode.WorkspaceEdit {
	const edit = new vscode.WorkspaceEdit();
	if (change.kind === "insertLine") {
		edit.insert(
			document.uri,
			new vscode.Position(change.line, 0),
			`${change.text}\n`,
		);
	} else {
		edit.replace(document.uri, document.lineAt(change.line).range, change.text);
	}
	return edit;
}

export class ProtoQuickFixProvider implements vscode.CodeActionProvider {
	static readonly providedCodeActionKinds = [
		vscode.CodeActionKind.QuickFix,
		vscode.CodeActionKind.SourceFixAll,
	];

	provideCodeActions(
		document: vscode.TextDocument,
		range: vscode.Range | vscode.Selection,
		context: vscode.CodeActionContext,
	): vscode.CodeAction[] {
		const actions: vscode.CodeAction[] = [];

		// One action per finding the cursor is on.
		for (const fixable of fixableIn(document, context.diagnostics)) {
			const action = new vscode.CodeAction(
				fixable.title,
				vscode.CodeActionKind.QuickFix,
			);
			action.edit = editFor(document, fixable.change);
			action.diagnostics = [fixable.diagnostic];
			// Marked preferred so a single keystroke takes it: there is only one
			// way to satisfy a rule that states its own fix.
			action.isPreferred = true;
			actions.push(action);
		}

		// And one that does the whole file, offered from anywhere in it.
		const all = fixableIn(
			document,
			vscode.languages.getDiagnostics(document.uri),
		);
		const composable = withoutCollisions(all.map((f) => f.change));
		if (composable.length > 1) {
			const action = new vscode.CodeAction(
				`Fix ${composable.length} AIP findings in this file`,
				vscode.CodeActionKind.SourceFixAll,
			);
			action.command = {
				command: FIX_ALL_COMMAND,
				title: "Fix all AIP findings",
				arguments: [document.uri],
			};
			actions.push(action);
		}

		// `range` decides which findings VS Code shows this for; it is the
		// editor's filter rather than ours, so nothing here narrows by it.
		void range;
		return actions;
	}
}

/**
 * Applies every unambiguous fix in one document.
 *
 * Rewrites the file in a single edit rather than applying each change in turn:
 * every change was computed against the original text, so applying one at a
 * time would invalidate the line numbers of the rest.
 *
 * @param uri - The document to fix; defaults to the active editor
 * @returns How many fixes were applied
 */
export async function fixAllInFile(uri?: vscode.Uri): Promise<number> {
	const target = uri ?? vscode.window.activeTextEditor?.document.uri;
	if (!target) {
		return 0;
	}
	const document = await vscode.workspace.openTextDocument(target);
	const all = fixableIn(document, vscode.languages.getDiagnostics(target));
	const changes = withoutCollisions(all.map((f) => f.change));
	if (changes.length === 0) {
		void vscode.window.showInformationMessage(
			"No AIP findings here can be fixed automatically.",
		);
		return 0;
	}

	const lines = document.getText().split(/\r?\n/);
	const edit = new vscode.WorkspaceEdit();
	edit.replace(
		document.uri,
		new vscode.Range(
			new vscode.Position(0, 0),
			document.lineAt(document.lineCount - 1).range.end,
		),
		applyChanges(lines, changes),
	);
	await vscode.workspace.applyEdit(edit);

	const deferred = all.length - changes.length;
	void vscode.window.showInformationMessage(
		deferred > 0
			? `Applied ${changes.length} fix(es). ${deferred} more share a line — lint again to apply them.`
			: `Applied ${changes.length} fix(es).`,
	);
	return changes.length;
}

/** Registers the provider and the fix-all command. */
export function registerQuickFixes(
	selector: vscode.DocumentSelector,
): vscode.Disposable[] {
	return [
		vscode.languages.registerCodeActionsProvider(
			selector,
			new ProtoQuickFixProvider(),
			{
				providedCodeActionKinds: ProtoQuickFixProvider.providedCodeActionKinds,
			},
		),
		vscode.commands.registerCommand(FIX_ALL_COMMAND, (uri?: vscode.Uri) =>
			fixAllInFile(uri),
		),
	];
}
