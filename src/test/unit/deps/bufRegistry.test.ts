/**
 * Tests for the registry pass.
 *
 * Every test injects a {@link CommandRunner}, so nothing here spawns `buf` or
 * touches the network — a test that reached the BSR would fail on a plane, in
 * CI and behind a proxy, which is exactly the set of conditions the production
 * code is built to survive.
 *
 * The canned payloads are the real ones: `{"commits":[…]}` newest first from
 * `buf registry module commit list --format=json`, the flat object from
 * `buf registry module info --format=json`, and the
 * `Failure: a module named "…" does not exist` a deleted module produces.
 *
 * The `behind` calculation gets the most attention, because its one subtle case
 * carries meaning: a pinned commit that is not on the page returns `undefined`,
 * which says "behind by an unknown amount" and is emphatically not zero.
 */

import { describe, expect, test } from "bun:test";
import type { CommandResult, CommandRunner } from "../../../deps/bufRegistry";
import {
	checkUpdates,
	computeBehind,
	execCommand,
	fetchCommits,
	fetchModuleInfo,
	isModuleMissing,
	parseCommitList,
	parseModuleInfo,
} from "../../../deps/bufRegistry";
import type { BufDep, DependencyModel } from "../../../shared/protocol";

/* ------------------------------------------------------------------ *
 * Canned CLI output
 * ------------------------------------------------------------------ */

/** `buf registry module commit list <ref> --format=json`, newest first. */
function commitListJson(
	commits: readonly { commit: string; time: string }[],
): string {
	return JSON.stringify({
		commits: commits.map((entry) => ({
			commit: entry.commit,
			create_time: entry.time,
			source_control_url: `https://github.com/acme/core/commit/${entry.commit}`,
		})),
	});
}

const THREE_COMMITS = commitListJson([
	{ commit: "aaa", time: "2025-03-01T00:00:00Z" },
	{ commit: "bbb", time: "2025-02-01T00:00:00Z" },
	{ commit: "ccc", time: "2025-01-01T00:00:00Z" },
]);

/** The failure the CLI prints for a module that has been deleted. */
const DELETED_FAILURE =
	'Failure: a module named "buf.build/acme/gone" does not exist';

/** A runner that answers every call the same way and records what it was asked. */
function runnerOf(
	reply: (
		command: string,
		args: readonly string[],
	) => Partial<CommandResult> | undefined,
): { run: CommandRunner; calls: string[][] } {
	const calls: string[][] = [];
	const run: CommandRunner = async (command, args) => {
		calls.push([command, ...args]);
		const result = reply(command, args) ?? {};
		return {
			code: result.code ?? 0,
			stdout: result.stdout ?? "",
			stderr: result.stderr ?? "",
			error: result.error,
		};
	};
	return { run, calls };
}

/** A dependency row as `buildDependencyModel` would have produced it. */
function dep(
	name: string,
	commit: string,
	extra: Partial<BufDep> = {},
): BufDep {
	const [remote = "", owner = "", module = ""] = name.split("/");
	return {
		name,
		remote,
		owner,
		module,
		commit,
		state: "declared",
		...extra,
	};
}

/** A model holding the given declared dependencies in one module. */
function modelOf(
	deps: readonly BufDep[],
	undeclared: readonly BufDep[] = [],
): DependencyModel {
	return {
		modules: [{ root: "/repo", name: "buf.build/acme/core", deps }],
		gen: [],
		undeclared,
		updatesChecked: false,
	};
}

/* ------------------------------------------------------------------ *
 * Parsing
 * ------------------------------------------------------------------ */

describe("parseCommitList", () => {
	test("reads the documented object shape in order", () => {
		expect(parseCommitList(THREE_COMMITS)).toEqual([
			{
				commit: "aaa",
				createTime: "2025-03-01T00:00:00Z",
				sourceControlUrl: "https://github.com/acme/core/commit/aaa",
			},
			{
				commit: "bbb",
				createTime: "2025-02-01T00:00:00Z",
				sourceControlUrl: "https://github.com/acme/core/commit/bbb",
			},
			{
				commit: "ccc",
				createTime: "2025-01-01T00:00:00Z",
				sourceControlUrl: "https://github.com/acme/core/commit/ccc",
			},
		]);
	});

	test("omits an absent source control url", () => {
		const parsed = parseCommitList('{"commits":[{"commit":"aaa"}]}');
		expect(parsed).toEqual([
			{ commit: "aaa", createTime: "", sourceControlUrl: undefined },
		]);
	});

	test("accepts a bare array and newline-delimited objects", () => {
		expect(parseCommitList('[{"commit":"aaa","create_time":"t"}]')).toEqual([
			{ commit: "aaa", createTime: "t", sourceControlUrl: undefined },
		]);
		expect(
			parseCommitList('{"commit":"aaa"}\n{"commit":"bbb"}\n').map(
				(c) => c.commit,
			),
		).toEqual(["aaa", "bbb"]);
	});

	test("drops entries with no commit id and returns nothing for junk", () => {
		expect(
			parseCommitList('{"commits":[{"create_time":"t"},null,"x"]}'),
		).toEqual([]);
		expect(parseCommitList("not json at all")).toEqual([]);
		expect(parseCommitList("")).toEqual([]);
		expect(parseCommitList('{"commits":"nope"}')).toEqual([]);
	});
});

describe("parseModuleInfo", () => {
	test("reads the flat object the CLI prints", () => {
		expect(
			parseModuleInfo(
				JSON.stringify({
					id: "01H",
					remote: "buf.build",
					owner: "acme",
					name: "core",
					create_time: "2024-01-01T00:00:00Z",
					state: "STATE_ACTIVE",
					default_label_name: "main",
				}),
			),
		).toEqual({
			id: "01H",
			remote: "buf.build",
			owner: "acme",
			name: "core",
			createTime: "2024-01-01T00:00:00Z",
			state: "STATE_ACTIVE",
			defaultLabelName: "main",
		});
	});

	test("fills missing fields with empty strings", () => {
		expect(parseModuleInfo('{"owner":"acme"}')).toEqual({
			id: "",
			remote: "",
			owner: "acme",
			name: "",
			createTime: "",
			state: "",
			defaultLabelName: "",
		});
	});

	test("returns nothing for output that is not a JSON object", () => {
		expect(parseModuleInfo("Failure: nope")).toBeUndefined();
		expect(parseModuleInfo("[1,2]")).toBeUndefined();
		expect(parseModuleInfo("")).toBeUndefined();
	});
});

describe("isModuleMissing", () => {
	test("recognises the deleted-module failure", () => {
		expect(isModuleMissing(DELETED_FAILURE)).toBe(true);
		expect(isModuleMissing(`something\n${DELETED_FAILURE}\n`)).toBe(true);
		// Unquoted, in case the CLI ever drops the quotes.
		expect(
			isModuleMissing("Failure: a module named buf.build/a/b does not exist"),
		).toBe(true);
	});

	test("does not mistake other failures for a deletion", () => {
		expect(isModuleMissing("Failure: unauthenticated")).toBe(false);
		expect(isModuleMissing("Failure: the label does not exist")).toBe(false);
		expect(isModuleMissing("")).toBe(false);
	});
});

/* ------------------------------------------------------------------ *
 * behind
 * ------------------------------------------------------------------ */

describe("computeBehind", () => {
	const commits = parseCommitList(THREE_COMMITS);

	test("counts the commits ahead of the pin", () => {
		expect(computeBehind(commits, "aaa")).toBe(0);
		expect(computeBehind(commits, "bbb")).toBe(1);
		expect(computeBehind(commits, "ccc")).toBe(2);
	});

	test("returns undefined, not zero, when the pin is not on the page", () => {
		// A commit old enough to have fallen off the first page is the furthest
		// behind a dependency can be; reporting 0 would invert the meaning.
		const behind = computeBehind(commits, "zzz");
		expect(behind).toBeUndefined();
		expect(behind).not.toBe(0);
	});

	test("returns undefined for an unpinned dependency", () => {
		expect(computeBehind(commits, "")).toBeUndefined();
	});

	test("returns undefined when the registry listed nothing", () => {
		expect(computeBehind([], "aaa")).toBeUndefined();
	});
});

/* ------------------------------------------------------------------ *
 * fetchCommits
 * ------------------------------------------------------------------ */

describe("fetchCommits", () => {
	test("asks the CLI for JSON and honours the configured binary", async () => {
		const { run, calls } = runnerOf(() => ({ stdout: THREE_COMMITS }));
		const lookup = await fetchCommits("buf.build/acme/core", {
			run,
			bufPath: "/opt/bin/buf",
		});
		expect(calls).toEqual([
			[
				"/opt/bin/buf",
				"registry",
				"module",
				"commit",
				"list",
				"buf.build/acme/core",
				"--format=json",
			],
		]);
		expect(lookup.missing).toBe(false);
		expect(lookup.error).toBeUndefined();
		expect(lookup.commits[0]?.commit).toBe("aaa");
	});

	test("maps the deleted-module failure onto missing", async () => {
		const { run } = runnerOf(() => ({ code: 1, stderr: DELETED_FAILURE }));
		const lookup = await fetchCommits("buf.build/acme/gone", { run });
		expect(lookup.missing).toBe(true);
		expect(lookup.error).toBe(DELETED_FAILURE);
		expect(lookup.commits).toEqual([]);
	});

	test("reports any other failure without claiming the module is gone", async () => {
		const { run } = runnerOf(() => ({
			code: 1,
			stderr: "Failure: unauthenticated: no token\n",
		}));
		const lookup = await fetchCommits("buf.build/acme/core", { run });
		expect(lookup.missing).toBe(false);
		expect(lookup.error).toBe("Failure: unauthenticated: no token");
	});

	test("falls back to the spawn error when the CLI printed nothing", async () => {
		const { run } = runnerOf(() => ({ code: 1, error: "spawn buf ENOENT" }));
		expect((await fetchCommits("buf.build/acme/core", { run })).error).toBe(
			"spawn buf ENOENT",
		);
	});

	test("treats an empty commit page as a failure to learn anything", async () => {
		const { run } = runnerOf(() => ({ stdout: '{"commits":[]}' }));
		const lookup = await fetchCommits("buf.build/acme/core", { run });
		expect(lookup.commits).toEqual([]);
		expect(lookup.error).toBe("registry returned no commits");
		expect(lookup.missing).toBe(false);
	});
});

describe("fetchModuleInfo", () => {
	test("parses a successful lookup", async () => {
		const { run, calls } = runnerOf(() => ({
			stdout: '{"owner":"acme","name":"core","default_label_name":"main"}',
		}));
		const info = await fetchModuleInfo("buf.build/acme/core", { run });
		expect(calls[0]).toEqual([
			"buf",
			"registry",
			"module",
			"info",
			"buf.build/acme/core",
			"--format=json",
		]);
		expect(info?.defaultLabelName).toBe("main");
	});

	test("returns nothing when the lookup failed", async () => {
		const { run } = runnerOf(() => ({ code: 1, stderr: DELETED_FAILURE }));
		expect(
			await fetchModuleInfo("buf.build/acme/gone", { run }),
		).toBeUndefined();
	});
});

/* ------------------------------------------------------------------ *
 * checkUpdates
 * ------------------------------------------------------------------ */

describe("checkUpdates", () => {
	test("fills in update status and flags the model as checked", async () => {
		const { run } = runnerOf(() => ({ stdout: THREE_COMMITS }));
		const model = await checkUpdates(
			modelOf([dep("buf.build/acme/core", "bbb")]),
			{ run },
		);
		expect(model.updatesChecked).toBe(true);
		expect(model.modules[0]?.deps[0]?.update).toEqual({
			latestCommit: "aaa",
			latestTime: "2025-03-01T00:00:00Z",
			behind: 1,
			error: undefined,
		});
		expect(model.modules[0]?.deps[0]?.state).toBe("declared");
	});

	test("looks a module up once however many rows pin it", async () => {
		const { run, calls } = runnerOf(() => ({ stdout: THREE_COMMITS }));
		const shared = "buf.build/acme/core";
		const model = await checkUpdates(
			{
				modules: [
					{ root: "/a", deps: [dep(shared, "aaa")] },
					{ root: "/b", deps: [dep(shared, "ccc")] },
				],
				gen: [],
				undeclared: [],
				updatesChecked: false,
			},
			{ run },
		);
		// One round trip; `behind` is then computed locally per pinned commit.
		expect(calls).toHaveLength(1);
		expect(model.modules[0]?.deps[0]?.update?.behind).toBe(0);
		expect(model.modules[1]?.deps[0]?.update?.behind).toBe(2);
	});

	test("turns a deleted module into an orphan, wherever it appears", async () => {
		const { run } = runnerOf((_command, args) =>
			args.includes("buf.build/acme/gone")
				? { code: 1, stderr: DELETED_FAILURE }
				: { stdout: THREE_COMMITS },
		);
		const model = await checkUpdates(
			modelOf(
				[dep("buf.build/acme/core", "aaa"), dep("buf.build/acme/gone", "ddd")],
				[dep("buf.build/acme/gone", "ddd", { state: "cached" })],
			),
			{ run },
		);
		const gone = model.modules[0]?.deps[1];
		expect(gone?.state).toBe("orphaned");
		// The status is still emitted: the required commit fields go empty and the
		// failure travels in `error`, so the row can say why rather than nothing.
		expect(gone?.update).toEqual({
			latestCommit: "",
			latestTime: "",
			error: DELETED_FAILURE,
		});
		expect(model.modules[0]?.deps[0]?.state).toBe("declared");
		expect(model.undeclared[0]?.state).toBe("orphaned");
	});

	test("keeps the on-disk state when the lookup merely failed", async () => {
		const { run } = runnerOf(() => ({ code: 1, stderr: "Failure: timeout" }));
		const model = await checkUpdates(
			modelOf([dep("buf.build/acme/core", "aaa", { state: "missing" })]),
			{ run },
		);
		expect(model.modules[0]?.deps[0]?.state).toBe("missing");
		expect(model.modules[0]?.deps[0]?.update?.error).toBe("Failure: timeout");
		expect(model.updatesChecked).toBe(true);
	});

	test("checks undeclared modules too", async () => {
		const { run } = runnerOf(() => ({ stdout: THREE_COMMITS }));
		const model = await checkUpdates(
			modelOf([], [dep("buf.build/acme/stray", "ccc", { state: "cached" })]),
			{ run },
		);
		expect(model.undeclared[0]?.update?.behind).toBe(2);
		expect(model.undeclared[0]?.state).toBe("cached");
	});

	test("makes no calls for a model with no dependencies", async () => {
		const { run, calls } = runnerOf(() => ({ stdout: THREE_COMMITS }));
		const model = await checkUpdates(modelOf([]), { run });
		expect(calls).toEqual([]);
		expect(model.updatesChecked).toBe(true);
	});

	test("returns the model untouched when cancelled before the first call", async () => {
		const { run, calls } = runnerOf(() => ({ stdout: THREE_COMMITS }));
		const original = modelOf([dep("buf.build/acme/core", "aaa")]);
		const model = await checkUpdates(original, {
			run,
			isCancelled: () => true,
		});
		expect(model).toBe(original);
		expect(calls).toEqual([]);
	});

	test("stops issuing calls once cancellation starts mid-flight", async () => {
		let cancelled = false;
		const { run, calls } = runnerOf(() => {
			cancelled = true;
			return { stdout: THREE_COMMITS };
		});
		const model = await checkUpdates(
			modelOf([
				dep("buf.build/acme/one", "aaa"),
				dep("buf.build/acme/two", "aaa"),
			]),
			{ run, concurrency: 1, isCancelled: () => cancelled },
		);
		expect(calls).toHaveLength(1);
		expect(model.modules[0]?.deps[1]?.update?.error).toBe("cancelled");
	});

	test("leaves the rest of the model alone", async () => {
		const { run } = runnerOf(() => ({ stdout: THREE_COMMITS }));
		const original: DependencyModel = {
			...modelOf([dep("buf.build/acme/core", "aaa")]),
			gen: [
				{
					path: "/repo/buf.gen.yaml",
					version: "v2",
					managed: true,
					plugins: [],
				},
			],
		};
		const model = await checkUpdates(original, { run });
		expect(model.gen).toBe(original.gen);
		expect(model.modules[0]?.root).toBe("/repo");
		expect(model.modules[0]?.name).toBe("buf.build/acme/core");
		// The input is not mutated; the panel may still be rendering it.
		expect(original.updatesChecked).toBe(false);
		expect(original.modules[0]?.deps[0]?.update).toBeUndefined();
	});
});

/* ------------------------------------------------------------------ *
 * The default runner
 * ------------------------------------------------------------------ */

describe("execCommand", () => {
	test("resolves rather than rejecting when the binary is missing", async () => {
		const result = await execCommand(
			"gapi-no-such-binary-xyz",
			["--help"],
			5000,
		);
		expect(result.code).not.toBe(0);
		expect(result.error).toBeTruthy();
		expect(result.stdout).toBe("");
	});
});
