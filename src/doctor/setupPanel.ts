/**
 * The setup check: what is installed, what is missing, and how to fix it.
 *
 * A Markdown document rather than a webview. It is read once on a new machine
 * and then rarely, so the cost of a panel — a bundle, a message protocol, a
 * theme to maintain — buys nothing here; and the install commands are meant to
 * be copied, which a text editor already does better than any page could.
 *
 * The one thing a document cannot do is run a command, so the actions are
 * offered beside it as buttons instead.
 */

import * as vscode from "vscode";
import {
	type Dependency,
	type EnvironmentReport,
	inspectEnvironment,
} from "./environment";

/** Reads the binary paths the user configured. */
function probeConfig(): {
	apiLinterPath: string;
	bufPath: string;
	clangFormatPath: string;
} {
	const config = vscode.workspace.getConfiguration("gapi");
	return {
		apiLinterPath: config.get<string>("binaryPath") || "api-linter",
		bufPath: config.get<string>("bufPath") || "buf",
		clangFormatPath: config.get<string>("clangFormatPath") || "clang-format",
	};
}

/** Inspects the machine using the configured paths. */
export async function currentEnvironment(): Promise<EnvironmentReport> {
	return inspectEnvironment(probeConfig());
}

/** `darwin` → `macOS`, for a heading a person reads. */
function platformName(platform: NodeJS.Platform): string {
	if (platform === "darwin") {
		return "macOS";
	}
	if (platform === "win32") {
		return "Windows";
	}
	if (platform === "linux") {
		return "Linux";
	}
	return platform;
}

/** One dependency as a Markdown section. */
function section(dep: Dependency): string {
	const mark =
		dep.state === "ok" ? "✓" : dep.requirement === "required" ? "✗" : "—";
	const out: string[] = [];

	out.push(`### ${mark} ${dep.label}`, "");
	out.push(dep.purpose, "");

	if (dep.state === "ok") {
		if (dep.version) {
			out.push(`Found \`${dep.version}\``);
		} else {
			out.push("Installed");
		}
		if (dep.location) {
			out.push("", `\`${dep.location}\``);
		}
		out.push("");
		return out.join("\n");
	}

	out.push(
		dep.requirement === "required"
			? "**Missing — this is required.**"
			: dep.requirement === "recommended"
				? "Missing. Recommended, not required."
				: "Not installed. Optional.",
		"",
	);
	if (dep.detail) {
		out.push(dep.detail, "");
	}

	if (dep.selfInstallable) {
		out.push(
			"The extension can install this for you — use **Install Dependencies** below.",
			"",
		);
	}

	const usable = dep.installHints.filter((h) => !h.unavailable);
	const rest = dep.installHints.filter((h) => h.unavailable);

	if (usable.length > 0) {
		out.push("Install it with:", "");
		for (const hint of usable) {
			out.push(`\`\`\`sh`, `# ${hint.via}`, hint.command, "```", "");
		}
	}
	if (rest.length > 0) {
		out.push(
			`<details><summary>Other ways (${rest
				.map((h) => h.via)
				.join(", ")} are not installed)</summary>`,
			"",
		);
		for (const hint of rest) {
			out.push(`\`\`\`sh`, `# ${hint.via}`, hint.command, "```", "");
		}
		out.push("</details>", "");
	}
	return out.join("\n");
}

/**
 * Renders the whole report.
 *
 * @param report - What was found on this machine
 * @returns A Markdown document
 */
export function renderSetup(report: EnvironmentReport): string {
	const out: string[] = [];
	const missing = report.dependencies.filter(
		(d) => d.requirement === "required" && d.state !== "ok",
	);

	out.push("# Proto setup", "");
	out.push(
		`Checked on **${platformName(report.platform)}** (\`${report.arch}\`).`,
		"",
	);

	if (report.ready) {
		out.push(
			"**Everything required is installed.** You can lint, format and generate.",
			"",
		);
	} else {
		out.push(
			`**${missing.length} required ${
				missing.length === 1 ? "item is" : "items are"
			} missing.** Linting will not work until ${
				missing.length === 1 ? "it is" : "they are"
			} installed.`,
			"",
		);
	}

	out.push("## Summary", "");
	out.push("| | Tool | Status | Version |", "| --- | --- | --- | --- |");
	for (const dep of report.dependencies) {
		const mark =
			dep.state === "ok" ? "✓" : dep.requirement === "required" ? "✗" : "—";
		const status =
			dep.state === "ok"
				? "installed"
				: dep.requirement === "required"
					? "**missing**"
					: "not installed";
		out.push(`| ${mark} | ${dep.label} | ${status} | ${dep.version ?? "—"} |`);
	}
	out.push("");

	/* --- where downloads live --------------------------------------- */

	out.push("## Download directory", "");
	out.push(
		"The extension keeps googleapis and the protobuf well-known types here,",
		"so your protos resolve `google/api/*` without vendoring anything into",
		"your repository.",
		"",
		`\`\`\`\n${report.gapiRoot}\n\`\`\``,
		"",
	);
	out.push(
		report.gapiRootExists
			? "The directory exists and has contents."
			: "The directory does not exist yet. **Install Dependencies** creates it.",
		"",
	);

	/* --- per tool ---------------------------------------------------- */

	out.push("## Tools", "");
	for (const dep of report.dependencies) {
		out.push(section(dep));
	}

	out.push("---", "");
	out.push(
		"Re-run this any time from the command palette — **Protobuf AIP Linter: Check Setup** —",
		"or by clicking the toolchain item in the status bar.",
		"",
	);
	return out.join("\n");
}

/**
 * Opens the setup report and offers the actions a document cannot perform.
 *
 * @param options - `prompt` offers to fix what is missing
 */
export async function showSetup(
	options: { prompt?: boolean } = {},
): Promise<EnvironmentReport> {
	const report = await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Window,
			title: "Checking the proto toolchain…",
		},
		() => currentEnvironment(),
	);

	const document = await vscode.workspace.openTextDocument({
		language: "markdown",
		content: renderSetup(report),
	});
	await vscode.window.showTextDocument(document, { preview: false });
	// The preview is how this is meant to be read: the tables and the fenced
	// install commands are the whole document.
	await vscode.commands.executeCommand("markdown.showPreview");

	if (options.prompt !== false) {
		const missing = report.dependencies.filter(
			(d) => d.requirement === "required" && d.state !== "ok",
		);
		const installable = missing.filter((d) => d.selfInstallable);
		if (installable.length > 0) {
			const choice = await vscode.window.showWarningMessage(
				`${missing.length} required item(s) missing. The extension can install ${installable.length} of them.`,
				"Install Dependencies",
			);
			if (choice === "Install Dependencies") {
				await vscode.commands.executeCommand("googleApiLinter.reinstallAll");
			}
		}
	}

	return report;
}
