/**
 * A `DependencyModel` taken from a real `buf` workspace.
 *
 * The panel renders this until the host's first `registry/update` arrives, so
 * the layout is designed against the shapes it actually has to survive: a
 * 94-file `googleapis`, a two-file helper module, an owner with ten modules
 * under it, and one orphan the registry has never heard of.
 *
 * Module references, commit ids, proto counts and `behind` distances were read
 * from `buf registry` and the local module cache. Three things are stand-ins
 * because no command reports them here: the workspace root, the timestamps on
 * commits that are already current, and the git SHAs behind the
 * `source_control_url` links. They are marked where they appear.
 */

import type {
	BufDep,
	DependencyModel,
	DepState,
	GenConfig,
	ModuleDeps,
} from "../../shared/protocol";
import type { CommitRow } from "./model";

const REMOTE = "buf.build";
const OWNER = "the-protobuf-project";

/** Stand-in workspace root; every absolute path below hangs off it. */
const ROOT = "/workspace/proto";
const BUF_YAML = `${ROOT}/buf.yaml`;

/** Where `buf` unpacks a module on Linux and macOS. */
function cacheDir(owner: string, module: string, commit: string): string {
	return `/home/dev/.cache/buf/modules/b5/${REMOTE}/${owner}/${module}/${commit}/files`;
}

interface DepInit {
	readonly owner?: string;
	readonly module: string;
	readonly commit: string;
	readonly protoCount?: number;
	readonly state?: DepState;
	readonly declared?: boolean;
	readonly behind?: number;
	readonly latestCommit?: string;
	readonly latestTime?: string;
	readonly error?: string;
}

function dep(init: DepInit): BufDep {
	const owner = init.owner ?? OWNER;
	const state: DepState = init.state ?? (init.declared ? "declared" : "cached");
	const update =
		init.error !== undefined
			? { latestCommit: "", latestTime: "", error: init.error }
			: init.latestCommit !== undefined
				? {
						latestCommit: init.latestCommit,
						latestTime: init.latestTime ?? "",
						behind: init.behind,
					}
				: undefined;

	return {
		name: `${REMOTE}/${owner}/${init.module}`,
		remote: REMOTE,
		owner,
		module: init.module,
		commit: init.commit,
		cachePath:
			state === "orphaned"
				? undefined
				: cacheDir(owner, init.module, init.commit),
		protoCount: init.protoCount,
		declaredIn: init.declared ? BUF_YAML : undefined,
		state,
		update,
	};
}

/** The one module the workspace's `buf.yaml` actually asks for. */
const GOOGLEAPIS: BufDep = dep({
	owner: "googleapis",
	module: "googleapis",
	commit: "004180b77378443887d3b55cabc00384",
	protoCount: 94,
	declared: true,
	behind: 8,
	latestCommit: "c17df5b2",
	latestTime: "2026-04-14T00:00:00Z",
});

/**
 * Modules sitting in the cache that no `buf.yaml` names.
 *
 * This is the list the panel exists for: everything here is one click and one
 * `buf.yaml` line away from being usable, and today nothing in VS Code says so.
 */
const UNDECLARED: readonly BufDep[] = [
	dep({
		module: "rfc",
		commit: "844dfa627e53499ba543aeabdcd2a663",
		protoCount: 188,
		behind: 2,
		latestCommit: "0fb3b05919464d84a2e18d200f5650c7",
		latestTime: "2026-09-08T00:00:00Z",
	}),
	dep({
		module: "store",
		commit: "46824ad9",
		protoCount: 24,
		behind: 3,
		latestCommit: "9b1c0e74",
		latestTime: "2026-09-05T00:00:00Z",
	}),
	dep({
		module: "mcp",
		commit: "d8286d36a0cc4df5bf65e342195ab82d",
		protoCount: 11,
		behind: 6,
		latestCommit: "7f30ab51",
		latestTime: "2026-09-02T00:00:00Z",
	}),
	dep({
		module: "orm",
		commit: "66cf7f7aa0f54e59ac6bc84faf0196ba",
		protoCount: 11,
		behind: 0,
		latestCommit: "66cf7f7aa0f54e59ac6bc84faf0196ba",
		// Stand-in: a current module's own commit time is not printed locally.
		latestTime: "2026-08-21T00:00:00Z",
	}),
	dep({
		module: "telemetry",
		commit: "4c408122dc3547e0b517464d5d949a8c",
		protoCount: 6,
		behind: 0,
		latestCommit: "4c408122dc3547e0b517464d5d949a8c",
		latestTime: "2026-08-19T00:00:00Z",
	}),
	dep({
		module: "protokit",
		commit: "d0f8434ca70b4debb4c106f937d79bd4",
		protoCount: 4,
		behind: 0,
		latestCommit: "d0f8434ca70b4debb4c106f937d79bd4",
		latestTime: "2026-08-11T00:00:00Z",
	}),
	dep({
		module: "buffers",
		commit: "ae728c88ce86433685f83d331549a78a",
		protoCount: 3,
		behind: 1,
		latestCommit: "1de4c7a0",
		latestTime: "2026-09-01T00:00:00Z",
	}),
	dep({
		module: "cache",
		commit: "e73eb5f8bce8427e84d30aba90b198f4",
		protoCount: 2,
		behind: 1,
		latestCommit: "5a90d2bb",
		latestTime: "2026-08-30T00:00:00Z",
	}),
	dep({
		owner: "bufbuild",
		module: "protovalidate",
		commit: "435963d1631043e694e56e6bcc3c79c3",
		protoCount: 2,
		behind: 5,
		latestCommit: "b2f0c418",
		latestTime: "2026-09-03T00:00:00Z",
	}),
	dep({
		module: "opentelementry",
		commit: "c51a17a53c2d493c8ddb2a562c98d357",
		state: "orphaned",
		error: `a module named "buf.build/the-protobuf-project/opentelementry" does not exist`,
	}),
];

const MODULE: ModuleDeps = {
	root: ROOT,
	deps: [GOOGLEAPIS],
};

const GEN: GenConfig = {
	path: `${ROOT}/buf.gen.yaml`,
	version: "v2",
	managed: true,
	plugins: [
		{
			ref: "buf.build/protocolbuffers/plugins/java",
			kind: "remote",
			out: "gen/java",
			opt: ["paths=source_relative"],
		},
		{
			ref: "buf.build/grpc/plugins/java",
			kind: "remote",
			out: "gen/java",
			opt: ["paths=source_relative"],
		},
		{
			ref: "buf.build/protocolbuffers/plugins/go",
			kind: "remote",
			out: "gen/go",
			opt: ["paths=source_relative"],
		},
		{
			ref: "buf.build/grpc/plugins/go",
			kind: "remote",
			out: "gen/go",
			opt: ["paths=source_relative"],
		},
	],
};

/** The model the panel renders before the host has said anything. */
export const FIXTURE_MODEL: DependencyModel = {
	modules: [MODULE],
	gen: [GEN],
	undeclared: UNDECLARED,
	updatesChecked: true,
};

/**
 * Commit lists the registry printed, newest first.
 *
 * `UpdateStatus` has no field for a history, so this cannot arrive from the
 * host — the detail pane falls back to the two points a live model can express.
 * The `source_control_url` SHAs are stand-ins; the `buf` commit ids are real.
 */
export const FIXTURE_HISTORY: Readonly<Record<string, readonly CommitRow[]>> = {
	[`${REMOTE}/${OWNER}/rfc`]: [
		{
			commit: "0fb3b05919464d84a2e18d200f5650c7",
			time: "2026-09-08T00:00:00Z",
			pinned: false,
			latest: true,
			sourceControlUrl:
				"https://github.com/the-protobuf-project/protobuf-rfc/commit/6f0a1c4d2b8e5a7390c1de4f6b2a8c05d7e39142",
		},
		{
			commit: "05872544",
			time: "2026-09-08T00:00:00Z",
			pinned: false,
			latest: false,
		},
		{
			commit: "844dfa627e53499ba543aeabdcd2a663",
			time: "2026-09-04T00:00:00Z",
			pinned: true,
			latest: false,
			sourceControlUrl:
				"https://github.com/the-protobuf-project/protobuf-rfc/commit/b18d4f7c9e2a3506df81ac4b6720e935cd1f8a47",
		},
		{
			commit: "9e460073",
			time: "2026-09-04T00:00:00Z",
			pinned: false,
			latest: false,
		},
	],
};
