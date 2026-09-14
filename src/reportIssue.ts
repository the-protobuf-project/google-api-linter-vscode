import * as vscode from "vscode";

/**
 * Where issues go when `package.json` names no usable repository.
 *
 * The same repository the manifest names. It disagreed — pointing at
 * `protobuf-aip-linter-vscode` — which only mattered if the manifest ever lost
 * its `repository.url`, and would then have sent every report to a repository
 * nobody reads.
 */
const FALLBACK_REPO: GithubRepo = {
	owner: "the-protobuf-project",
	repo: "google-api-linter-vscode",
};

/** Owner and repository parsed out of a GitHub remote URL. */
export interface GithubRepo {
	readonly owner: string;
	readonly repo: string;
}

/**
 * Owner and repo from a GitHub remote, or null when it is not one.
 *
 * @param repoUrl - A `repository.url` value, possibly `git+…` or `…​.git`
 */
export function parseGithubRepo(repoUrl: string): GithubRepo | null {
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
		return { owner: segments[0], repo: segments[1] };
	} catch {
		return null;
	}
}

/** What the report needs to know about the machine. */
export interface IssueContext {
	readonly extensionId: string;
	readonly version: string;
	readonly vscodeVersion: string;
	readonly platform: string;
	readonly arch: string;
}

/**
 * The issue body, in Markdown.
 *
 * @param ctx - Versions and platform to record
 * @returns The body exactly as it should reach GitHub
 */
export function issueBody(ctx: IssueContext): string {
	return [
		"### Environment",
		"",
		`- Extension: \`${ctx.extensionId}\` v${ctx.version}`,
		`- VS Code: ${ctx.vscodeVersion}`,
		`- OS: ${ctx.platform} (${ctx.arch})`,
		"",
		"### What went wrong",
		"",
		"",
		"### Steps to reproduce",
		"",
		"",
		"### Logs (optional)",
		"",
		"**View → Output → Protobuf AIP Linter** — paste relevant lines here.",
		"",
	].join("\n");
}

/**
 * The issue link, as a `Uri` whose query is still unencoded.
 *
 * This is the whole bug it exists to prevent. `URLSearchParams.toString()`
 * percent-encodes the query, and then `openExternal` serialises the `Uri` and
 * encodes it a second time — so `###` left as `%2523%2523%2523`, GitHub decoded
 * once, and every heading in the template arrived as literal `%23%23%23`.
 *
 * `Uri.from` takes the query raw and `toString()` encodes it exactly once,
 * which is the one encoding GitHub expects.
 *
 * @param repo - Owner and repository
 * @param title - Issue title, unencoded
 * @param body - Issue body, unencoded
 */
export function issueUri(
	repo: GithubRepo,
	title: string,
	body: string,
): vscode.Uri {
	return vscode.Uri.from({
		scheme: "https",
		authority: "github.com",
		path: `/${repo.owner}/${repo.repo}/issues/new`,
		query: `title=${title}&body=${body}`,
	});
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
		const repo = (repoUrl ? parseGithubRepo(repoUrl) : null) ?? FALLBACK_REPO;

		const body = issueBody({
			extensionId: context.extension.id,
			version,
			vscodeVersion: vscode.version,
			platform: process.platform,
			arch: process.arch,
		});

		void vscode.env.openExternal(issueUri(repo, "Bug: ", body));
	});
}
