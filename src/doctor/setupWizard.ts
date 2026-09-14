/**
 * First-run setup: install what is missing, without touching what is not.
 *
 * Distinct from `reinstallAll`, which deletes `~/.gapi` before rebuilding it.
 * That is the right tool for a corrupted install and the wrong one for a new
 * machine, where there is nothing to delete and the reader should not be shown
 * a destructive prompt to get started.
 *
 * One rule decides how each dependency is handled. Anything living under
 * `~/.gapi` is the extension's own directory, so it is downloaded directly.
 * Anything installed by a system package manager is run **in a terminal the
 * reader can see**, never silently — several of those commands need `sudo`, and
 * an extension that quietly asks for a password has earned every bit of
 * suspicion that follows.
 */

import * as vscode from "vscode";
import type { BinaryManager } from "../binaryManager";
import type { Dependency, EnvironmentReport } from "./environment";
import { currentEnvironment } from "./setupPanel";

/** What one step of the setup did. */
interface StepOutcome {
	readonly label: string;
	readonly ok: boolean;
	readonly detail?: string;
}

/** The install command to offer for a dependency, if any is usable here. */
function preferredHint(
	dep: Dependency,
): { via: string; command: string } | undefined {
	// A hint whose manager is absent cannot be run, so it is never the one
	// offered — it is only listed in the report, where it reads as advice.
	return dep.installHints.find((hint) => !hint.unavailable);
}

/**
 * Runs a package-manager command in a visible terminal.
 *
 * Deliberately not `execFile`. These commands prompt — for a password, for a
 * confirmation, for a license — and a captured subprocess would hang on the
 * first prompt with nothing on screen to explain why. A terminal also lets the
 * reader see exactly what is about to run before it does.
 */
function runInTerminal(name: string, command: string): vscode.Terminal {
	const terminal = vscode.window.createTerminal({ name });
	terminal.show();
	terminal.sendText(command);
	return terminal;
}

/**
 * Installs everything missing that the extension owns, and offers a terminal
 * for everything it does not.
 *
 * @param binaryManager - Owns the downloads into `~/.gapi`
 * @param log - Output channel for the detail
 */
export async function runSetup(
	binaryManager: BinaryManager,
	log: vscode.OutputChannel,
	options: { force?: boolean } = {},
): Promise<EnvironmentReport> {
	const force = options.force === true;
	let report = await currentEnvironment();

	// Forcing re-downloads what is already present. The reason to want that is
	// a corrupted or half-extracted download, which reads as installed here —
	// the check looks for contents, not for integrity it cannot verify.
	const missing = force
		? report.dependencies.filter(
				(dep) => dep.selfInstallable || preferredHint(dep) !== undefined,
			)
		: report.dependencies.filter((dep) => dep.state !== "ok");

	if (missing.length === 0) {
		void vscode.window.showInformationMessage(
			"Everything is already installed.",
		);
		return report;
	}

	const downloads = missing.filter((dep) => dep.selfInstallable);
	const manual = missing.filter(
		(dep) => !dep.selfInstallable && preferredHint(dep) !== undefined,
	);

	/* ---------------------------------------------------------------- *
	 * Say what will happen before it happens
	 * ---------------------------------------------------------------- */

	const plan: string[] = [];
	if (downloads.length > 0) {
		plan.push(
			`${force ? "Re-download" : "Download"} into ${report.gapiRoot}: ${downloads
				.map((dep) => dep.label)
				.join(", ")}`,
		);
	}
	for (const dep of manual) {
		const hint = preferredHint(dep);
		if (hint) {
			plan.push(`Run in a terminal: ${hint.command}`);
		}
	}
	if (plan.length === 0) {
		// Everything missing needs a package manager this machine does not have.
		void vscode.window.showWarningMessage(
			"Nothing can be installed automatically here. Check Setup lists the commands for this platform.",
		);
		await vscode.commands.executeCommand("googleApiLinter.checkSetup");
		return report;
	}

	const confirm = await vscode.window.showInformationMessage(
		force ? "Reinstall the proto toolchain?" : "Set up the proto toolchain?",
		{
			modal: true,
			detail: force
				? `${plan.join("\n")}\n\nExisting files are replaced.`
				: plan.join("\n"),
		},
		force ? "Reinstall" : "Set Up",
	);
	if (confirm !== (force ? "Reinstall" : "Set Up")) {
		return report;
	}

	/* ---------------------------------------------------------------- *
	 * The parts the extension owns
	 * ---------------------------------------------------------------- */

	const outcomes: StepOutcome[] = [];

	if (downloads.length > 0) {
		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: "Setting up the proto toolchain",
				cancellable: false,
			},
			async (progress) => {
				const step = 100 / downloads.length;
				for (const dep of downloads) {
					progress.report({ message: dep.label });
					try {
						// Every `ensure*` takes the same force flag, which is what
						// makes it re-fetch rather than return the file it found.
						if (dep.id === "api-linter") {
							await binaryManager.ensureBinary(force);
						} else if (dep.id === "googleapis") {
							await binaryManager.ensureGoogleapis(force);
						} else if (dep.id === "protobuf") {
							await binaryManager.ensureProtobuf(force);
						}
						outcomes.push({ label: dep.label, ok: true });
						log.appendLine(`[setup] installed ${dep.label}`);
					} catch (error) {
						const detail =
							error instanceof Error ? error.message : String(error);
						outcomes.push({ label: dep.label, ok: false, detail });
						log.appendLine(`[setup] ${dep.label} failed: ${detail}`);
					}
					progress.report({ increment: step });
				}
			},
		);
	}

	/* ---------------------------------------------------------------- *
	 * The parts a package manager owns
	 * ---------------------------------------------------------------- */

	for (const dep of manual) {
		const hint = preferredHint(dep);
		if (!hint) {
			continue;
		}
		const choice = await vscode.window.showInformationMessage(
			`${force ? "Reinstall" : "Install"} ${dep.label} with ${hint.via}?`,
			{
				modal: true,
				detail: `${hint.command}\n\nThis runs in a terminal so you can see it.`,
			},
			"Run it",
			"Skip",
		);
		if (choice === "Run it") {
			runInTerminal(`install ${dep.label}`, hint.command);
			outcomes.push({
				label: dep.label,
				ok: true,
				detail: "started in a terminal",
			});
		} else {
			outcomes.push({ label: dep.label, ok: false, detail: "skipped" });
		}
	}

	/* ---------------------------------------------------------------- *
	 * Re-check, since the point is the end state rather than the steps
	 * ---------------------------------------------------------------- */

	report = await currentEnvironment();
	const failed = outcomes.filter((o) => !o.ok && o.detail !== "skipped");

	if (report.ready && failed.length === 0) {
		const choice = await vscode.window.showInformationMessage(
			"Proto toolchain is ready.",
			"Lint Workspace",
		);
		if (choice === "Lint Workspace") {
			await vscode.commands.executeCommand("googleApiLinter.lintWorkspace");
		}
	} else if (failed.length > 0) {
		const choice = await vscode.window.showErrorMessage(
			`Setup finished with ${failed.length} failure(s): ${failed
				.map((f) => f.label)
				.join(", ")}.`,
			"Show Output",
			"Check Setup",
		);
		if (choice === "Show Output") {
			log.show(true);
		} else if (choice === "Check Setup") {
			await vscode.commands.executeCommand("googleApiLinter.checkSetup");
		}
	} else {
		// Nothing failed, but something is still missing — a terminal install
		// the reader has not finished yet, most likely.
		void vscode.window.showInformationMessage(
			"Setup started. Re-run Check Setup once the terminal finishes.",
		);
	}

	return report;
}
