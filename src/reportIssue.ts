import * as vscode from "vscode";

const FALLBACK_ISSUES_NEW =
	"https://github.com/the-protobuf-project/google-api-linter-vscode/issues/new";

function githubIssuesNewUrl(repoUrl: string): string | null {
	try {
		const normalized = repoUrl.replace(/^git\+/, "").replace(/\.git\s*$/i, "");
		const u = new URL(normalized);
		if (u.hostname !== "github.com") {
			return null;
		}
		const segments = u.pathname.replace(/^\/+|\/+$/g, "").split("/");
		if (segments.length < 2) {
			return null;
		}
		const [owner, repo] = segments;
		return `https://github.com/${owner}/${repo}/issues/new`;
	} catch {
		return null;
	}
}

/**
 * Opens the GitHub "new issue" page with a pre-filled bug template.
 */
export function registerReportIssueCommand(
	context: vscode.ExtensionContext,
): vscode.Disposable {
	return vscode.commands.registerCommand("googleApiLinter.reportIssue", () => {
		const ext = vscode.extensions.getExtension(context.extension.id);
		const pkg = ext?.packageJSON as
			| { version?: string; repository?: { url?: string } }
			| undefined;
		const version = pkg?.version ?? "unknown";
		const repoUrl = pkg?.repository?.url;
		const base =
			(repoUrl && githubIssuesNewUrl(repoUrl)) ?? FALLBACK_ISSUES_NEW;

		const body = [
			"### Environment",
			"",
			`- Extension: \`${context.extension.id}\` v${version}`,
			`- VS Code: ${vscode.version}`,
			`- OS: ${process.platform} (${process.arch})`,
			"",
			"### What went wrong",
			"",
			"",
			"### Steps to reproduce",
			"",
			"",
			"### Logs (optional)",
			"",
			"**View → Output → Google API Linter** — paste relevant lines here.",
			"",
		].join("\n");

		const params = new URLSearchParams({
			title: "Bug: ",
			body,
		});
		const url = `${base}?${params.toString()}`;
		void vscode.env.openExternal(vscode.Uri.parse(url));
	});
}
