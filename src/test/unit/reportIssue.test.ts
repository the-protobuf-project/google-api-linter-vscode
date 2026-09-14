/**
 * Tests for the "Report Issue" link.
 *
 * One of these covers a bug that shipped. The query was built with
 * `URLSearchParams.toString()`, which percent-encodes, and then handed to
 * `openExternal`, which serialises the `Uri` and encodes a second time. GitHub
 * decodes once, so every `###` in the template arrived as a literal
 * `%23%23%23` and the issue body was unreadable.
 *
 * Nothing in the old code could have caught it: the URL was correct right up
 * to the moment VS Code re-encoded it, so the bug lived in the seam between two
 * functions that were each behaving as documented. The fix is to hand the query
 * over unencoded and let exactly one encoder run, and the test asserts that the
 * markers which break — `#`, newline, space — leave here raw.
 */

import { describe, expect, test } from "bun:test";
import {
	type IssueContext,
	issueBody,
	issueUri,
	parseGithubRepo,
} from "../../reportIssue";

const CTX: IssueContext = {
	extensionId: "the-protobuf-project.protobuf-aip-linter",
	version: "2.1.0",
	vscodeVersion: "1.137.0",
	platform: "darwin",
	arch: "arm64",
};

describe("parseGithubRepo", () => {
	test("reads owner and repo from an https remote", () => {
		expect(parseGithubRepo("https://github.com/acme/widgets")).toEqual({
			owner: "acme",
			repo: "widgets",
		});
	});

	test("tolerates the git+ prefix and .git suffix npm writes", () => {
		expect(parseGithubRepo("git+https://github.com/acme/widgets.git")).toEqual({
			owner: "acme",
			repo: "widgets",
		});
	});

	test("refuses a host that is not github", () => {
		expect(parseGithubRepo("https://gitlab.com/acme/widgets")).toBeNull();
	});

	test("refuses a url with no repository in it", () => {
		expect(parseGithubRepo("https://github.com/acme")).toBeNull();
		expect(parseGithubRepo("not a url")).toBeNull();
	});
});

describe("issueBody", () => {
	test("uses real Markdown headings", () => {
		const body = issueBody(CTX);
		expect(body).toContain("### Environment");
		expect(body).toContain("### What went wrong");
		expect(body).toContain("### Steps to reproduce");
		// The symptom of the shipped bug, asserted directly: an already-encoded
		// heading here would be encoded again downstream.
		expect(body).not.toContain("%23");
	});

	test("records the versions a maintainer asks for first", () => {
		const body = issueBody(CTX);
		expect(body).toContain("v2.1.0");
		expect(body).toContain("1.137.0");
		expect(body).toContain("darwin (arm64)");
	});
});

describe("issueUri", () => {
	const repo = { owner: "acme", repo: "widgets" };

	test("hands the query over unencoded, for exactly one encoder to run", () => {
		const uri = issueUri(repo, "Bug: ", issueBody(CTX));
		// `Uri.query` is what `toString()` will encode. If it already contained
		// `%23`, the second pass would turn it into `%2523` — which is precisely
		// what reached GitHub before.
		expect(uri.query).toContain("### Environment");
		expect(uri.query).not.toContain("%23");
		expect(uri.query).not.toContain("%2523");
	});

	test("points at the repository's new-issue page", () => {
		const uri = issueUri(repo, "Bug: ", "body");
		expect(uri.scheme).toBe("https");
		expect(uri.authority).toBe("github.com");
		expect(uri.path).toBe("/acme/widgets/issues/new");
	});

	test("keeps title and body as separate parameters", () => {
		const uri = issueUri(repo, "Bug: something", "the body");
		expect(uri.query.startsWith("title=Bug: something&body=")).toBe(true);
	});
});
