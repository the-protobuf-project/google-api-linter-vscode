/**
 * Tests for `ApiLinterProvider`: the part of the lint pipeline that owns
 * processes and diagnostic collections.
 *
 * Two things here are worth protecting. The first is that the provider keeps
 * two separate collections — `protobuf-aip-linter` for per-file api-linter
 * findings and `protobuf-aip-linter-syntax` for the workspace-wide `buf build`
 * pass — precisely so the two passes cannot overwrite each other's results.
 * Merging them looks harmless and silently deletes one pass's output every time
 * the other runs.
 *
 * The second is the performance rewrite's shape: `buf build` is one debounced
 * workspace-level run rather than one run per file, so the debounce and the
 * self-coalescing behind it are load-bearing. `scheduleWorkspaceSyntaxCheck` is
 * called on every save; if a burst of saves stopped collapsing into one run the
 * extension would be back to a `buf build` per keystroke.
 *
 * Nothing here spawns a real process. `node:child_process` is replaced for the
 * duration of this file with a scripted fake, installed in `beforeAll` and put
 * back in `afterAll` so other test files still get the real one. The binary
 * itself is injected through `getBinaryManager()`, whose methods are stubbed on
 * the instance the provider built.
 */

import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	mock,
	spyOn,
	test,
} from "bun:test";
import * as realCp from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
	TextDocument,
	DiagnosticCollection as VsDiagnosticCollection,
	OutputChannel as VsOutputChannel,
	Uri as VsUri,
} from "vscode";
import { ApiLinterProvider } from "../../../linterProvider";
import type { LinterOptions, LinterProblem } from "../../../types";
import { makeDocument, syntheticPath } from "../support/fixtures";
import {
	type Diagnostic,
	DiagnosticCollection,
	languages,
	Uri,
	window,
	workspace,
} from "../support/vscode";

/** The real module, captured before anything replaces it. */
const ACTUAL_CP = { ...realCp };

/** One scripted child process run. */
interface FakeRun {
	stdout?: string;
	stderr?: string;
	/** Exit code reported to `close`; `null` stands for "killed by a signal". */
	code?: number | null;
	/** Emit `error` instead of closing, as a missing binary does. */
	error?: NodeJS.ErrnoException;
	/** Stay open until `kill()` is called. */
	hang?: boolean;
}

/** What the provider asked to spawn. */
interface SpawnCall {
	bin: string;
	args: string[];
	cwd?: string;
}

/**
 * Stands in for a `ChildProcess`, implementing only what the provider touches:
 * `stdout`/`stderr` data events, `error`, `close` and `kill`.
 */
class FakeChild extends EventEmitter {
	readonly stdout = new EventEmitter();
	readonly stderr = new EventEmitter();
	killed = false;
	private closed = false;

	/** Emits `close` once; later calls are ignored, as a real process's are. */
	settle(code: number | null): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
		this.emit("close", code);
	}

	kill(): boolean {
		this.killed = true;
		// A killed process reports a null exit code alongside its signal.
		queueMicrotask(() => this.settle(null));
		return true;
	}
}

/** Every spawn the provider attempted since the last reset. */
let spawnCalls: SpawnCall[] = [];
/** Children handed out since the last reset, in spawn order. */
let spawnedChildren: FakeChild[] = [];
/** What each spawn should do. Reassigned per test. */
let respond: (call: SpawnCall) => FakeRun = () => ({ code: 0 });

/** Replaces `cp.spawn`; the events fire on a later turn, as real ones do. */
function fakeSpawn(
	bin: string,
	args: string[] = [],
	opts: { cwd?: string } = {},
): FakeChild {
	const call: SpawnCall = { bin, args, cwd: opts.cwd };
	spawnCalls.push(call);
	const run = respond(call);
	const child = new FakeChild();
	spawnedChildren.push(child);
	// The provider attaches its listeners after `spawn` returns, so nothing may
	// be emitted synchronously.
	setTimeout(() => {
		if (run.error) {
			child.emit("error", run.error);
			return;
		}
		if (run.stdout) {
			child.stdout.emit("data", Buffer.from(run.stdout));
		}
		if (run.stderr) {
			child.stderr.emit("data", Buffer.from(run.stderr));
		}
		if (!run.hang) {
			child.settle(run.code === undefined ? 0 : run.code);
		}
	}, 0);
	return child;
}

/**
 * The stub collection plus the `set(entries)` overload the provider uses to
 * publish a whole batch, and the syntax check to publish a whole workspace.
 */
class BatchCollection extends DiagnosticCollection {
	/** Mirrors the base collection, keyed by path rather than uri string. */
	private readonly mirror = new Map<string, readonly Diagnostic[]>();

	set(
		uriOrEntries: Uri | Array<[Uri, readonly Diagnostic[] | undefined]>,
		diagnostics?: readonly Diagnostic[],
	): void {
		if (Array.isArray(uriOrEntries)) {
			for (const [uri, entry] of uriOrEntries) {
				this.set(uri, entry);
			}
			return;
		}
		super.set(uriOrEntries, diagnostics);
		if (diagnostics === undefined) {
			this.mirror.delete(uriOrEntries.fsPath);
		} else {
			this.mirror.set(uriOrEntries.fsPath, diagnostics);
		}
	}

	delete(uri: Uri): void {
		super.delete(uri);
		this.mirror.delete(uri.fsPath);
	}

	clear(): void {
		super.clear();
		this.mirror.clear();
	}

	dispose(): void {
		super.dispose();
		this.mirror.clear();
	}

	/** Paths currently carrying diagnostics. */
	paths(): string[] {
		return [...this.mirror.keys()];
	}

	/** What is published for one path, or undefined when nothing is. */
	forPath(fsPath: string): readonly Diagnostic[] | undefined {
		return this.mirror.get(fsPath);
	}

	/** Every diagnostic currently published, whatever file it belongs to. */
	flat(): Diagnostic[] {
		return [...this.mirror.values()].flat();
	}
}

/** Records what the provider logged, so a silent failure is still visible. */
class RecordingChannel {
	readonly lines: string[] = [];
	readonly name = "test";
	appendLine(line: string): void {
		this.lines.push(line);
	}
	append(): void {}
	replace(): void {}
	clear(): void {}
	show(): void {}
	hide(): void {}
	dispose(): void {}
}

/** A provider wired to collections and a channel the test can read back. */
interface Harness {
	provider: ApiLinterProvider;
	/** The per-file api-linter collection, passed in by the caller. */
	findings: BatchCollection;
	/** The `buf build` collection the provider creates for itself. */
	syntax: BatchCollection;
	channel: RecordingChannel;
}

/** Collections handed out by `languages.createDiagnosticCollection`, newest last. */
let createdCollections: BatchCollection[] = [];

function makeProvider(): Harness {
	const findings = new BatchCollection("protobuf-aip-linter");
	const channel = new RecordingChannel();
	const before = createdCollections.length;
	const provider = new ApiLinterProvider(
		findings as unknown as VsDiagnosticCollection,
		channel as unknown as VsOutputChannel,
	);
	const syntax = createdCollections[before];
	return { provider, findings, syntax, channel };
}

/** Replaces the binary manager's downloads with a path the test controls. */
function stubBinary(provider: ApiLinterProvider, binaryPath: string): void {
	const manager = provider.getBinaryManager();
	manager.ensureBinary = async () => binaryPath;
	manager.ensureGoogleapis = async () => {};
	manager.ensureProtobuf = async () => {};
	manager.getGoogleapisDir = () => syntheticPath("synthetic", "googleapis");
	manager.getProtobufDir = () => syntheticPath("synthetic", "protobuf");
}

/** Options with every toggle off, matching `linterUtils.test.ts`. */
function options(overrides: Partial<LinterOptions> = {}): LinterOptions {
	return {
		protoPath: [],
		disableRules: [],
		enableRules: [],
		setExitStatus: false,
		...overrides,
	};
}

/**
 * One api-linter problem, with the 1-based coordinates the binary emits.
 *
 * @param start - `[line, column]`, both 1-based
 * @param end - `[line, column]`, both 1-based
 * @param overrides - Fields to replace
 */
function problem(
	start: [number, number],
	end: [number, number],
	overrides: Partial<LinterProblem> = {},
): LinterProblem {
	return {
		message: "Message names should use UpperCamelCase.",
		location: {
			start_position: { line_number: start[0], column_number: start[1] },
			end_position: { line_number: end[0], column_number: end[1] },
			path: "book.proto",
		},
		rule_id: "core::0123::resource-annotation",
		rule_doc_uri: "https://linter.aip.dev/123/resource-annotation",
		...overrides,
	};
}

/** api-linter's JSON output shape: one entry per file it was asked about. */
function jsonOutput(
	results: Array<{ file_path: string; problems: LinterProblem[] }>,
): string {
	return JSON.stringify(results);
}

/** A directory that never exists, so no config or proto-path probing hits it. */
const SYNTHETIC = syntheticPath("synthetic", "protos");
const BOOK_PROTO = path.join(SYNTHETIC, "book.proto");

/** The stub uri for a path, cast to the type the provider is written against. */
function protoUri(fsPath: string): VsUri {
	return Uri.file(fsPath) as unknown as VsUri;
}

/** What a collection holds for a path, or undefined when it holds nothing. */
function diagnosticsFor(
	collection: BatchCollection,
	fsPath: string,
): readonly Diagnostic[] | undefined {
	return collection.forPath(fsPath);
}

/** Reports `root` as the only open folder; `afterEach` closes it again. */
function openWorkspace(root: string): void {
	workspace.workspaceFolders = [{ uri: { fsPath: root } }];
}

/** Collects the notifications of one kind shown while `body` runs. */
async function withNotifications(
	kind: "showInformationMessage" | "showErrorMessage",
	body: () => Promise<void>,
): Promise<string[]> {
	const shown: string[] = [];
	const original = window[kind];
	window[kind] = ((message: string) => {
		shown.push(message);
		return Promise.resolve(undefined);
	}) as typeof window.showInformationMessage;
	try {
		await body();
	} finally {
		window[kind] = original;
	}
	return shown;
}

/** Runs `body` with `gapi` settings overridden, then restores. */
async function withConfig<T>(
	values: Record<string, unknown>,
	body: () => Promise<T>,
): Promise<T> {
	const original = workspace.getConfiguration;
	workspace.getConfiguration = (() => ({
		get: (key: string, fallback?: unknown) =>
			key in values ? values[key] : fallback,
	})) as typeof workspace.getConfiguration;
	try {
		return await body();
	} finally {
		workspace.getConfiguration = original;
	}
}

let binaryPath: string;
let tempRoot: string;
let originalCreate: typeof languages.createDiagnosticCollection;
let homedir: ReturnType<typeof spyOn<typeof os, "homedir">>;

beforeAll(() => {
	mock.module("node:child_process", () => ({
		...ACTUAL_CP,
		spawn: fakeSpawn,
	}));
	// `buildSharedLinterArgs` adds `~/.gapi/googleapis` to the proto path when it
	// exists, so a developer who has one would otherwise get different argv from
	// CI. Bun resolves the real home at startup and ignores a mutated `HOME`, so
	// the function itself has to be replaced.
	homedir = spyOn(os, "homedir");
	homedir.mockReturnValue(syntheticPath("synthetic", "home"));
	originalCreate = languages.createDiagnosticCollection;
	languages.createDiagnosticCollection = (name?: string) => {
		const collection = new BatchCollection(name);
		createdCollections.push(collection);
		return collection;
	};
	// `lintDocument` checks the binary is really on disk before spawning it.
	tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gapi-provider-"));
	binaryPath = path.join(tempRoot, "api-linter");
	fs.writeFileSync(binaryPath, "", "utf8");
});

afterAll(() => {
	mock.module("node:child_process", () => ACTUAL_CP);
	languages.createDiagnosticCollection = originalCreate;
	homedir.mockRestore();
	fs.rmSync(tempRoot, { recursive: true, force: true });
});

afterEach(() => {
	spawnCalls = [];
	spawnedChildren = [];
	createdCollections = [];
	respond = () => ({ code: 0 });
	workspace.workspaceFolders = undefined;
});

describe("lintUri", () => {
	test("maps a finding's 1-based position to a 0-based range", async () => {
		respond = () => ({
			stdout: jsonOutput([
				{ file_path: "book.proto", problems: [problem([12, 4], [12, 20])] },
			]),
		});
		const { provider, findings } = makeProvider();

		await provider.lintUri(protoUri(BOOK_PROTO), {
			binaryPath,
			options: options(),
		});

		const published = diagnosticsFor(findings, BOOK_PROTO);
		expect(published).toHaveLength(1);
		expect(published?.[0].range.start.line).toBe(11);
		expect(published?.[0].range.start.character).toBe(3);
		expect(published?.[0].range.end.character).toBe(19);
		expect(published?.[0].source).toBe("protobuf-aip-linter");
	});

	test("puts a finding on line 1 at the top of the file", async () => {
		respond = () => ({
			stdout: jsonOutput([
				{ file_path: "book.proto", problems: [problem([1, 1], [1, 8])] },
			]),
		});
		const { provider, findings } = makeProvider();

		await provider.lintUri(protoUri(BOOK_PROTO), {
			binaryPath,
			options: options(),
		});

		const published = diagnosticsFor(findings, BOOK_PROTO);
		expect(published?.[0].range.start.line).toBe(0);
		expect(published?.[0].range.start.character).toBe(0);
	});

	test("clamps a finding the binary reports at column 0", async () => {
		// 0 is out of range for a 1-based column; the range must stay valid.
		respond = () => ({
			stdout: jsonOutput([
				{ file_path: "book.proto", problems: [problem([3, 0], [3, 0])] },
			]),
		});
		const { provider, findings } = makeProvider();

		await provider.lintUri(protoUri(BOOK_PROTO), {
			binaryPath,
			options: options(),
		});

		const published = diagnosticsFor(findings, BOOK_PROTO);
		expect(published?.[0].range.start.character).toBe(0);
		expect(published?.[0].range.end.character).toBe(0);
	});

	test("carries the rule id and severity of every problem", async () => {
		respond = () => ({
			stdout: jsonOutput([
				{
					file_path: "book.proto",
					problems: [
						problem([1, 1], [1, 2], { message: "first" }),
						problem([2, 1], [2, 2], { message: "second" }),
					],
				},
			]),
		});
		const { provider, findings } = makeProvider();

		await provider.lintUri(protoUri(BOOK_PROTO), {
			binaryPath,
			options: options(),
		});

		const published = diagnosticsFor(findings, BOOK_PROTO) ?? [];
		expect(published.map((d) => d.message)).toEqual(["first", "second"]);
		expect((published[0].code as unknown as { value: string }).value).toBe(
			"core::0123::resource-annotation",
		);
		// DiagnosticSeverity.Error
		expect(published[0].severity).toBe(0);
	});

	test("leaves the syntax collection untouched", async () => {
		respond = () => ({
			stdout: jsonOutput([
				{ file_path: "book.proto", problems: [problem([1, 1], [1, 2])] },
			]),
		});
		const { provider, findings, syntax } = makeProvider();

		await provider.lintUri(protoUri(BOOK_PROTO), {
			binaryPath,
			options: options(),
		});

		expect(findings.uris()).toHaveLength(1);
		expect(syntax.uris()).toEqual([]);
	});

	test("runs the binary from the file's own directory, base name last", async () => {
		const { provider } = makeProvider();

		await provider.lintUri(protoUri(BOOK_PROTO), {
			binaryPath,
			options: options(),
		});

		expect(spawnCalls).toHaveLength(1);
		expect(spawnCalls[0].bin).toBe(binaryPath);
		expect(spawnCalls[0].cwd).toBe(SYNTHETIC);
		expect(spawnCalls[0].args[spawnCalls[0].args.length - 1]).toBe(
			"book.proto",
		);
	});

	test("clears the findings of a file that now lints clean", async () => {
		const { provider, findings } = makeProvider();
		respond = () => ({
			stdout: jsonOutput([
				{ file_path: "book.proto", problems: [problem([1, 1], [1, 2])] },
			]),
		});
		await provider.lintUri(protoUri(BOOK_PROTO), {
			binaryPath,
			options: options(),
		});
		expect(diagnosticsFor(findings, BOOK_PROTO)).toHaveLength(1);

		respond = () => ({ stdout: "[]" });
		await provider.lintUri(protoUri(BOOK_PROTO), {
			binaryPath,
			options: options(),
		});
		expect(diagnosticsFor(findings, BOOK_PROTO)).toEqual([]);
	});

	test("ignores a uri that is not a .proto", async () => {
		const { provider, findings } = makeProvider();

		await provider.lintUri(protoUri(path.join(SYNTHETIC, "README.md")), {
			binaryPath,
			options: options(),
		});

		expect(spawnCalls).toEqual([]);
		expect(findings.uris()).toEqual([]);
	});

	test("publishes nothing and does not throw when the binary is missing", async () => {
		const missing = Object.assign(new Error("spawn ENOENT"), {
			code: "ENOENT",
		}) as NodeJS.ErrnoException;
		respond = () => ({ error: missing });
		const { provider, findings, channel } = makeProvider();

		await provider.lintUri(protoUri(BOOK_PROTO), {
			binaryPath,
			options: options(),
		});

		expect(diagnosticsFor(findings, BOOK_PROTO)).toEqual([]);
		expect(channel.lines.some((l) => l.includes("binary not found"))).toBe(
			true,
		);
	});

	test("survives garbage on stdout", async () => {
		respond = () => ({
			stdout: "panic: runtime error\n\x00\x01 not json at all",
		});
		const { provider, findings } = makeProvider();

		await provider.lintUri(protoUri(BOOK_PROTO), {
			binaryPath,
			options: options(),
		});

		expect(diagnosticsFor(findings, BOOK_PROTO)).toEqual([]);
	});

	test("survives a binary that writes nothing at all", async () => {
		respond = () => ({ stdout: "", stderr: "", code: 0 });
		const { provider, findings } = makeProvider();

		await provider.lintUri(protoUri(BOOK_PROTO), {
			binaryPath,
			options: options(),
		});

		expect(diagnosticsFor(findings, BOOK_PROTO)).toEqual([]);
	});

	test("keeps the findings when the binary exits 1", async () => {
		// Exit 1 means "findings exist", not "the run failed".
		respond = () => ({
			code: 1,
			stdout: jsonOutput([
				{ file_path: "book.proto", problems: [problem([4, 2], [4, 6])] },
			]),
		});
		const { provider, findings } = makeProvider();

		await provider.lintUri(protoUri(BOOK_PROTO), {
			binaryPath,
			options: options(),
		});

		expect(diagnosticsFor(findings, BOOK_PROTO)).toHaveLength(1);
	});

	test("clears the file when the binary exits non-zero with nothing to say", async () => {
		respond = () => ({ code: 2, stdout: "", stderr: "fatal: bad flag" });
		const { provider, findings, channel } = makeProvider();

		await provider.lintUri(protoUri(BOOK_PROTO), {
			binaryPath,
			options: options(),
		});

		expect(diagnosticsFor(findings, BOOK_PROTO)).toEqual([]);
		expect(channel.lines.some((l) => l.includes("exited with code 2"))).toBe(
			true,
		);
	});

	test("falls back to stderr when stdout carried no findings", async () => {
		// A compile error goes to stderr; it still belongs on the file.
		respond = () => ({
			code: 1,
			stdout: "",
			stderr: "book.proto:7:3: syntax error: unexpected '}'",
		});
		const { provider, findings } = makeProvider();

		await provider.lintUri(protoUri(BOOK_PROTO), {
			binaryPath,
			options: options(),
		});

		const published = diagnosticsFor(findings, BOOK_PROTO);
		expect(published).toHaveLength(1);
		expect(published?.[0].message).toBe("syntax error: unexpected '}'");
		expect(published?.[0].source).toBe("protobuf-aip-linter (syntax)");
		expect(published?.[0].range.start.line).toBe(6);
	});

	test("skips a second lint of the same uri while one is in flight", async () => {
		respond = () => ({ stdout: "[]" });
		const { provider } = makeProvider();

		await Promise.all([
			provider.lintUri(protoUri(BOOK_PROTO), {
				binaryPath,
				options: options(),
			}),
			provider.lintUri(protoUri(BOOK_PROTO), {
				binaryPath,
				options: options(),
			}),
		]);

		expect(spawnCalls).toHaveLength(1);
	});

	test("lints two different files concurrently", async () => {
		respond = () => ({ stdout: "[]" });
		const { provider, findings } = makeProvider();
		const other = path.join(SYNTHETIC, "shelf.proto");

		await Promise.all([
			provider.lintUri(protoUri(BOOK_PROTO), {
				binaryPath,
				options: options(),
			}),
			provider.lintUri(protoUri(other), { binaryPath, options: options() }),
		]);

		expect(spawnCalls).toHaveLength(2);
		expect(findings.uris()).toHaveLength(2);
	});
});

describe("lintDocument", () => {
	/** A `.proto` document with the extra fields `lintDocument` reads. */
	function protoDocument(
		text: string,
		fsPath: string = BOOK_PROTO,
	): TextDocument & { isDirty: boolean; saved: number } {
		const document = makeDocument(text, fsPath) as TextDocument & {
			isDirty: boolean;
			saved: number;
			save: () => Promise<boolean>;
		};
		document.isDirty = false;
		document.saved = 0;
		document.save = async () => {
			document.saved += 1;
			return true;
		};
		return document;
	}

	test("publishes findings against the document's own uri", async () => {
		respond = () => ({
			stdout: jsonOutput([
				{ file_path: "book.proto", problems: [problem([2, 3], [2, 9])] },
			]),
		});
		const { provider, findings } = makeProvider();
		stubBinary(provider, binaryPath);

		await provider.lintDocument(protoDocument("message M {\n}\n"), false, true);

		const published = diagnosticsFor(findings, BOOK_PROTO);
		expect(published).toHaveLength(1);
		expect(published?.[0].range.start.line).toBe(1);
	});

	test("keeps a finding reported past the end of the document", async () => {
		// The provider does not clamp to the document's length; VS Code does that
		// when it renders. What matters is that the finding is not dropped.
		respond = () => ({
			stdout: jsonOutput([
				{ file_path: "book.proto", problems: [problem([100, 1], [100, 5])] },
			]),
		});
		const { provider, findings } = makeProvider();
		stubBinary(provider, binaryPath);

		await provider.lintDocument(protoDocument("a\nb\nc\n"), false, true);

		const published = diagnosticsFor(findings, BOOK_PROTO);
		expect(published).toHaveLength(1);
		expect(published?.[0].range.start.line).toBe(99);
	});

	test("ignores a document that is not a .proto", async () => {
		const { provider, findings } = makeProvider();
		stubBinary(provider, binaryPath);

		await provider.lintDocument(
			protoDocument("# notes\n", path.join(SYNTHETIC, "README.md")),
			false,
			true,
		);

		expect(spawnCalls).toEqual([]);
		expect(findings.uris()).toEqual([]);
	});

	test("saves a dirty document before linting when asked", async () => {
		respond = () => ({ stdout: "[]" });
		const { provider } = makeProvider();
		stubBinary(provider, binaryPath);
		const document = protoDocument("message M {}\n");
		document.isDirty = true;

		await provider.lintDocument(document, true, true);

		expect(document.saved).toBe(1);
	});

	test("does not save a document that has no unsaved changes", async () => {
		respond = () => ({ stdout: "[]" });
		const { provider } = makeProvider();
		stubBinary(provider, binaryPath);
		const document = protoDocument("message M {}\n");

		await provider.lintDocument(document, true, true);

		expect(document.saved).toBe(0);
	});

	test("runs once more when a lint is requested while one is in flight", async () => {
		respond = () => ({ stdout: "[]" });
		const { provider } = makeProvider();
		stubBinary(provider, binaryPath);
		const document = protoDocument("message M {}\n");

		const first = provider.lintDocument(document, false, true);
		// Queued rather than run, and replayed once the first finishes.
		const second = provider.lintDocument(document, false, true);
		await Promise.all([first, second]);
		// The replay is fire-and-forget, so give it a turn to spawn.
		await settle();

		expect(spawnCalls).toHaveLength(2);
	});

	test("clears the file's diagnostics when the run fails outright", async () => {
		respond = () => ({
			error: Object.assign(new Error("spawn EACCES"), {
				code: "EACCES",
			}) as NodeJS.ErrnoException,
		});
		const { provider, findings } = makeProvider();
		stubBinary(provider, binaryPath);

		await provider.lintDocument(protoDocument("message M {}\n"), false, true);

		expect(diagnosticsFor(findings, BOOK_PROTO)).toEqual([]);
	});

	test("publishes findings through the visible progress path too", async () => {
		respond = () => ({
			stdout: jsonOutput([
				{ file_path: "book.proto", problems: [problem([5, 1], [5, 3])] },
			]),
		});
		const { provider, findings } = makeProvider();
		stubBinary(provider, binaryPath);

		await provider.lintDocument(protoDocument("message M {}\n"), false, false);

		expect(diagnosticsFor(findings, BOOK_PROTO)).toHaveLength(1);
	});

	test("tells the user when a visible lint fails", async () => {
		respond = () => ({
			error: Object.assign(new Error("spawn ENOENT"), {
				code: "ENOENT",
			}) as NodeJS.ErrnoException,
		});
		const { provider, findings } = makeProvider();
		stubBinary(provider, binaryPath);

		const shown = await withNotifications("showErrorMessage", () =>
			provider.lintDocument(protoDocument("message M {}\n"), false, false),
		);

		expect(shown).toHaveLength(1);
		expect(shown[0]).toContain("Protobuf AIP Linter error");
		expect(diagnosticsFor(findings, BOOK_PROTO)).toEqual([]);
	});

	test("stays quiet when a silent lint fails", async () => {
		// Lint-on-save is silent; a missing binary must not pop a dialog on every
		// keystroke's worth of saves.
		respond = () => ({
			error: Object.assign(new Error("spawn ENOENT"), {
				code: "ENOENT",
			}) as NodeJS.ErrnoException,
		});
		const { provider } = makeProvider();
		stubBinary(provider, binaryPath);

		const shown = await withNotifications("showErrorMessage", () =>
			provider.lintDocument(protoDocument("message M {}\n"), false, true),
		);

		expect(shown).toEqual([]);
	});

	test("reports a binary that vanished between download and spawn", async () => {
		const { provider, findings, channel } = makeProvider();
		stubBinary(provider, path.join(tempRoot, "not-there"));

		await provider.lintDocument(protoDocument("message M {}\n"), false, true);

		expect(spawnCalls).toEqual([]);
		expect(diagnosticsFor(findings, BOOK_PROTO)).toEqual([]);
		expect(channel.lines.some((l) => l.includes("Binary not found"))).toBe(
			true,
		);
	});
});

describe("workspace syntax check", () => {
	/** The open folder every test in this block builds from. */
	const ROOT = syntheticPath("synthetic", "workspace");
	/** Where a relative `proto/library.proto` in buf's output resolves to. */
	const LIBRARY = path.normalize(path.join(ROOT, "proto", "library.proto"));

	test("collapses a burst of calls into a single buf build", async () => {
		// The integration notes promise this is safe to call on every save.
		const { provider } = makeProvider();
		openWorkspace(ROOT);

		for (let at = 0; at < 20; at++) {
			provider.scheduleWorkspaceSyntaxCheck(5);
		}
		await settle(60);

		expect(spawnCalls).toHaveLength(1);
		expect(spawnCalls[0].bin).toBe("buf");
		expect(spawnCalls[0].args).toEqual(["build"]);
		expect(spawnCalls[0].cwd).toBe(ROOT);
		provider.dispose();
	});

	test("waits out the debounce window before spawning anything", async () => {
		const { provider } = makeProvider();
		openWorkspace(ROOT);

		// The default window is half a second; nothing may run before it.
		provider.scheduleWorkspaceSyntaxCheck();
		await settle(60);

		expect(spawnCalls).toEqual([]);
		provider.dispose();
	});

	test("publishes errors to the syntax collection, not the findings one", async () => {
		respond = () => ({
			code: 1,
			stderr: "proto/library.proto:12:4: syntax error: unexpected '}'",
		});
		const { provider, findings, syntax } = makeProvider();
		openWorkspace(ROOT);

		await provider.runWorkspaceSyntaxCheck();

		const published = diagnosticsFor(syntax, LIBRARY) ?? [];
		expect(published).toHaveLength(1);
		expect(published[0].message).toBe("syntax error: unexpected '}'");
		expect(published[0].source).toBe("protobuf-aip-linter (syntax)");
		expect(published[0].range.start.line).toBe(11);
		expect(published[0].range.start.character).toBe(3);
		expect(findings.paths()).toEqual([]);
	});

	test("leaves api-linter findings alone while it publishes and clears", async () => {
		// The whole reason the two collections are separate: neither pass may
		// delete the other's results.
		const { provider, findings, syntax } = makeProvider();
		respond = () => ({
			stdout: jsonOutput([
				{ file_path: "book.proto", problems: [problem([1, 1], [1, 2])] },
			]),
		});
		await provider.lintUri(protoUri(BOOK_PROTO), {
			binaryPath,
			options: options(),
		});
		openWorkspace(ROOT);

		respond = () => ({ code: 1, stderr: "proto/library.proto:1:1: broken" });
		await provider.runWorkspaceSyntaxCheck();
		expect(diagnosticsFor(findings, BOOK_PROTO)).toHaveLength(1);
		expect(syntax.paths()).toEqual([LIBRARY]);

		// A later clean build clears only the syntax side.
		respond = () => ({ code: 0 });
		await provider.runWorkspaceSyntaxCheck();
		expect(syntax.paths()).toEqual([]);
		expect(diagnosticsFor(findings, BOOK_PROTO)).toHaveLength(1);
	});

	test("replaces the previous run's errors rather than accumulating them", async () => {
		const { provider, syntax } = makeProvider();
		openWorkspace(ROOT);

		respond = () => ({
			code: 1,
			stderr: [
				"proto/library.proto:1:1: first",
				"proto/other.proto:2:2: second",
			].join("\n"),
		});
		await provider.runWorkspaceSyntaxCheck();
		expect(syntax.paths()).toHaveLength(2);

		respond = () => ({ code: 1, stderr: "proto/library.proto:1:1: first" });
		await provider.runWorkspaceSyntaxCheck();
		expect(syntax.paths()).toEqual([LIBRARY]);
	});

	test("groups several errors in one file together", async () => {
		respond = () => ({
			code: 1,
			stderr: [
				"proto/library.proto:12:4: unexpected '}'",
				"proto/library.proto:40:9: expected ';'",
			].join("\n"),
		});
		const { provider, syntax } = makeProvider();
		openWorkspace(ROOT);

		await provider.runWorkspaceSyntaxCheck();

		expect(diagnosticsFor(syntax, LIBRARY)?.map((d) => d.message)).toEqual([
			"unexpected '}'",
			"expected ';'",
		]);
	});

	// Commit e178bdd, "Fix syntax-error parsing on Windows, on CRLF, and on
	// malformed findings". buf's output is split on "\n", so a CRLF stream leaves
	// a carriage return on every line; the pattern has to tolerate it or Windows
	// users see no syntax errors at all.
	test("parses CRLF output", async () => {
		respond = () => ({
			code: 1,
			stderr:
				"proto/library.proto:12:4: unexpected '}'\r\nproto/library.proto:40:9: expected ';'\r\n",
		});
		const { provider, syntax } = makeProvider();
		openWorkspace(ROOT);

		await provider.runWorkspaceSyntaxCheck();

		const published = diagnosticsFor(syntax, LIBRARY) ?? [];
		expect(published).toHaveLength(2);
		// The carriage return must not be swallowed into the message text.
		expect(published[0].message).toBe("unexpected '}'");
		expect(published[0].message.endsWith("\r")).toBe(false);
	});

	// The other half of e178bdd: `([^:]+)` stops at the colon in `C:\...`, so a
	// Windows absolute path never matched and the whole file went unreported.
	test("parses a Windows absolute path", async () => {
		respond = () => ({
			code: 1,
			stderr: "C:\\src\\proto\\library.proto:12:4: syntax error",
		});
		const { provider, syntax } = makeProvider();
		openWorkspace(ROOT);

		await provider.runWorkspaceSyntaxCheck();

		// Where it resolves to depends on the host's path rules; that it is
		// reported at all is the regression being pinned.
		expect(syntax.paths()).toHaveLength(1);
		const [diagnostic] = syntax.flat();
		expect(diagnostic.message).toBe("syntax error");
		expect(diagnostic.range.start.line).toBe(11);
	});

	test("resolves an absolute path in the output as given", async () => {
		respond = () => ({ code: 1, stderr: `${LIBRARY}:5:2: unexpected token` });
		const { provider, syntax } = makeProvider();
		openWorkspace(ROOT);

		await provider.runWorkspaceSyntaxCheck();

		expect(syntax.paths()).toEqual([LIBRARY]);
		expect(diagnosticsFor(syntax, LIBRARY)?.[0].range.start.character).toBe(1);
	});

	test("clamps a column of zero and skips a line of zero", async () => {
		respond = () => ({
			code: 1,
			stderr: [
				"proto/library.proto:7:0: unterminated string",
				"proto/library.proto:0:1: file is empty",
			].join("\n"),
		});
		const { provider, syntax } = makeProvider();
		openWorkspace(ROOT);

		await provider.runWorkspaceSyntaxCheck();

		const published = diagnosticsFor(syntax, LIBRARY) ?? [];
		expect(published).toHaveLength(1);
		expect(published[0].range.start.line).toBe(6);
		expect(published[0].range.start.character).toBe(0);
	});

	test("ignores output lines that name no proto file", async () => {
		respond = () => ({
			code: 1,
			stderr: [
				"Failure: build failed",
				"buf.yaml:3:1: invalid configuration",
				"2026/02/20 14:49:31 not a diagnostic",
			].join("\n"),
		});
		const { provider, syntax } = makeProvider();
		openWorkspace(ROOT);

		await provider.runWorkspaceSyntaxCheck();

		expect(syntax.paths()).toEqual([]);
	});

	test("survives garbage on stderr", async () => {
		respond = () => ({ code: 2, stderr: "\x00\x01\x02 panic: nil map\n\n:::" });
		const { provider, syntax } = makeProvider();
		openWorkspace(ROOT);

		await provider.runWorkspaceSyntaxCheck();

		expect(syntax.paths()).toEqual([]);
	});

	test("survives a buf that fails and writes nothing", async () => {
		respond = () => ({ code: 3, stderr: "" });
		const { provider, syntax } = makeProvider();
		openWorkspace(ROOT);

		await provider.runWorkspaceSyntaxCheck();

		expect(syntax.paths()).toEqual([]);
	});

	test("leaves the last known errors alone when buf is not installed", async () => {
		const { provider, syntax } = makeProvider();
		openWorkspace(ROOT);
		respond = () => ({ code: 1, stderr: "proto/library.proto:1:1: broken" });
		await provider.runWorkspaceSyntaxCheck();
		expect(syntax.paths()).toEqual([LIBRARY]);

		// buf missing is not evidence the file is now clean, so nothing is cleared.
		respond = () => ({
			error: Object.assign(new Error("spawn ENOENT"), {
				code: "ENOENT",
			}) as NodeJS.ErrnoException,
		});
		await provider.runWorkspaceSyntaxCheck();

		expect(syntax.paths()).toEqual([LIBRARY]);
	});

	test("does nothing when no folder is open", async () => {
		const { provider, syntax } = makeProvider();

		await provider.runWorkspaceSyntaxCheck();

		expect(spawnCalls).toEqual([]);
		expect(syntax.paths()).toEqual([]);
	});

	test("spawns the binary named by gapi.bufPath", async () => {
		const { provider } = makeProvider();
		openWorkspace(ROOT);

		await withConfig({ bufPath: "/opt/bin/buf" }, () =>
			provider.runWorkspaceSyntaxCheck(),
		);

		expect(spawnCalls[0].bin).toBe("/opt/bin/buf");
	});

	test("queues one more run rather than spawning a second buf", async () => {
		respond = () => ({
			code: 1,
			stderr: "proto/library.proto:1:1: broken",
			hang: true,
		});
		const { provider } = makeProvider();
		openWorkspace(ROOT);

		const running = provider.runWorkspaceSyntaxCheck();
		await settle();
		expect(spawnCalls).toHaveLength(1);

		// Two more requests while the first is in flight collapse into one replay.
		await provider.runWorkspaceSyntaxCheck();
		await provider.runWorkspaceSyntaxCheck();
		expect(spawnCalls).toHaveLength(1);

		respond = () => ({ code: 0 });
		spawnedChildren[0].settle(1);
		await running;
		// The replay goes back through the default debounce window.
		await settle(40);
		expect(spawnCalls).toHaveLength(1);
		await settle(600);
		expect(spawnCalls).toHaveLength(2);
		provider.dispose();
	});
});

describe("lintWorkspace", () => {
	const DIR_A = path.join(SYNTHETIC, "a");
	const DIR_B = path.join(SYNTHETIC, "b");
	const ONE = path.join(DIR_A, "one.proto");
	const TWO = path.join(DIR_A, "two.proto");
	const THREE = path.join(DIR_B, "three.proto");

	/** Reports `paths` as the workspace's proto files while `body` runs. */
	async function withProtos(
		paths: string[],
		body: () => Promise<void>,
	): Promise<void> {
		const original = workspace.findFiles;
		// Only the proto glob is answered: the module graph uses the same API to
		// look for buf configs and must keep finding none.
		workspace.findFiles = (async (include: string) =>
			include === "**/*.proto"
				? paths.map((p) => Uri.file(p))
				: []) as typeof workspace.findFiles;
		try {
			await body();
		} finally {
			workspace.findFiles = original;
		}
	}

	/** Collects the notifications shown while `body` runs. */
	function withMessages(body: () => Promise<void>): Promise<string[]> {
		return withNotifications("showInformationMessage", body);
	}

	test("says nothing when a silent run finds no protos", async () => {
		// The startup lint runs on every window. A workspace with no protos is
		// an ordinary thing to open, and interrupting to announce it would make
		// the feature a nuisance in every unrelated project.
		const { provider } = makeProvider();
		stubBinary(provider, binaryPath);

		const quiet = await withMessages(() =>
			withProtos([], () => provider.lintWorkspace({ silent: true })),
		);
		expect(quiet).toEqual([]);

		// Asked for explicitly, the same case must still answer: the reader
		// pressed a button and is owed a result.
		const asked = await withMessages(() =>
			withProtos([], () => provider.lintWorkspace()),
		);
		expect(asked).toEqual(["No .proto files found in workspace."]);
		provider.dispose();
	});

	test("does not announce completion of a silent run", async () => {
		const { provider } = makeProvider();
		stubBinary(provider, binaryPath);

		const quiet = await withMessages(() =>
			withProtos([ONE, TWO], () => provider.lintWorkspace({ silent: true })),
		);
		// The findings are the result, and they are already in Problems.
		expect(quiet).toEqual([]);
		provider.dispose();
	});

	test("runs one process per directory, not one per file", async () => {
		const { provider } = makeProvider();
		stubBinary(provider, binaryPath);

		await withProtos([ONE, TWO, THREE], () => provider.lintWorkspace());
		provider.dispose();

		expect(spawnCalls).toHaveLength(2);
		expect(spawnCalls.map((c) => c.cwd)).toEqual([DIR_A, DIR_B]);
		expect(spawnCalls[0].args.slice(-2)).toEqual(["one.proto", "two.proto"]);
	});

	test("routes each file's findings back to its own uri", async () => {
		respond = () => ({
			code: 1,
			stdout: jsonOutput([
				{
					file_path: "one.proto",
					problems: [problem([2, 1], [2, 4], { message: "in one" })],
				},
				{
					file_path: "two.proto",
					problems: [problem([9, 5], [9, 7], { message: "in two" })],
				},
			]),
		});
		const { provider, findings } = makeProvider();
		stubBinary(provider, binaryPath);

		await withProtos([ONE, TWO], () => provider.lintWorkspace());
		provider.dispose();

		expect(diagnosticsFor(findings, ONE)?.map((d) => d.message)).toEqual([
			"in one",
		]);
		expect(diagnosticsFor(findings, TWO)?.map((d) => d.message)).toEqual([
			"in two",
		]);
	});

	test("clears a file in the batch that now reports nothing", async () => {
		const { provider, findings } = makeProvider();
		stubBinary(provider, binaryPath);
		respond = () => ({
			stdout: jsonOutput([
				{ file_path: "one.proto", problems: [problem([1, 1], [1, 2])] },
			]),
		});
		await provider.lintUri(protoUri(ONE), { binaryPath, options: options() });
		expect(diagnosticsFor(findings, ONE)).toHaveLength(1);

		// The batch covers one.proto but reports only two.proto, so one.proto's
		// stale findings must go.
		respond = () => ({
			code: 1,
			stdout: jsonOutput([
				{ file_path: "two.proto", problems: [problem([3, 1], [3, 2])] },
			]),
		});
		await withProtos([ONE, TWO], () => provider.lintWorkspace());
		provider.dispose();

		expect(diagnosticsFor(findings, ONE)).toEqual([]);
		expect(diagnosticsFor(findings, TWO)).toHaveLength(1);
	});

	test("puts a batch's syntax errors ahead of its findings", async () => {
		respond = () => ({
			code: 1,
			stdout: jsonOutput([
				{
					file_path: "one.proto",
					problems: [problem([9, 1], [9, 4], { message: "style" })],
				},
			]),
			stderr: "one.proto:2:1: unexpected '}'",
		});
		const { provider, findings } = makeProvider();
		stubBinary(provider, binaryPath);

		await withProtos([ONE], () => provider.lintWorkspace());
		provider.dispose();

		const published = diagnosticsFor(findings, ONE) ?? [];
		expect(published.map((d) => d.message)).toEqual([
			"unexpected '}'",
			"style",
		]);
		expect(published.map((d) => d.source)).toEqual([
			"protobuf-aip-linter (syntax)",
			"protobuf-aip-linter",
		]);
	});

	test("clears the batch's files when the binary prints garbage", async () => {
		const { provider, findings } = makeProvider();
		stubBinary(provider, binaryPath);
		respond = () => ({
			stdout: jsonOutput([
				{ file_path: "one.proto", problems: [problem([1, 1], [1, 2])] },
			]),
		});
		await provider.lintUri(protoUri(ONE), { binaryPath, options: options() });

		respond = () => ({ code: 1, stdout: "panic: runtime error\nnot json" });
		await withProtos([ONE, TWO], () => provider.lintWorkspace());
		provider.dispose();

		expect(diagnosticsFor(findings, ONE)).toEqual([]);
		expect(diagnosticsFor(findings, TWO)).toEqual([]);
	});

	test("still publishes what a batch that exited non-zero reported", async () => {
		respond = () => ({
			code: 2,
			stdout: jsonOutput([
				{ file_path: "one.proto", problems: [problem([1, 1], [1, 2])] },
			]),
			stderr: "warning: unknown rule",
		});
		const { provider, findings, channel } = makeProvider();
		stubBinary(provider, binaryPath);

		await withProtos([ONE], () => provider.lintWorkspace());
		provider.dispose();

		expect(diagnosticsFor(findings, ONE)).toHaveLength(1);
		expect(channel.lines.some((l) => l.includes("exited with code 2"))).toBe(
			true,
		);
	});

	test("leaves a batch's files untouched when the process never starts", async () => {
		const { provider, findings } = makeProvider();
		stubBinary(provider, binaryPath);
		respond = () => ({
			stdout: jsonOutput([
				{ file_path: "one.proto", problems: [problem([1, 1], [1, 2])] },
			]),
		});
		await provider.lintUri(protoUri(ONE), { binaryPath, options: options() });

		// A batch that cannot run has learned nothing, so it publishes nothing --
		// including no clear.
		respond = () => ({
			error: Object.assign(new Error("spawn ENOENT"), {
				code: "ENOENT",
			}) as NodeJS.ErrnoException,
		});
		await withProtos([ONE], () => provider.lintWorkspace());
		provider.dispose();

		expect(diagnosticsFor(findings, ONE)).toHaveLength(1);
	});

	test("schedules exactly one workspace syntax check afterwards", async () => {
		// The rewrite's headline change: one `buf build` for the whole run rather
		// than one per file.
		const { provider } = makeProvider();
		stubBinary(provider, binaryPath);
		openWorkspace(SYNTHETIC);

		await withProtos([ONE, TWO, THREE], () => provider.lintWorkspace());
		await settle(600);
		provider.dispose();

		expect(spawnCalls.filter((c) => c.bin === "buf")).toHaveLength(1);
		expect(spawnCalls[spawnCalls.length - 1].args).toEqual(["build"]);
	});

	test("refuses a second workspace lint while one is running", async () => {
		respond = () => ({ code: 0, stdout: "[]", hang: true });
		const { provider } = makeProvider();
		stubBinary(provider, binaryPath);

		let running: Promise<void> = Promise.resolve();
		const shown = await withMessages(async () => {
			await withProtos([ONE], async () => {
				running = provider.lintWorkspace();
				await settle();
				await provider.lintWorkspace();
			});
		});
		expect(spawnCalls).toHaveLength(1);
		expect(shown).toEqual(["Workspace lint is already running."]);

		spawnedChildren[0].settle(0);
		await running;
		provider.dispose();
	});

	test("says so when the workspace holds no protos", async () => {
		const { provider } = makeProvider();
		stubBinary(provider, binaryPath);

		const shown = await withMessages(() =>
			withProtos([], () => provider.lintWorkspace()),
		);
		provider.dispose();

		expect(spawnCalls).toEqual([]);
		expect(shown).toEqual(["No .proto files found in workspace."]);
	});
});

describe("dispose", () => {
	test("disposes the syntax collection but not the one it was given", () => {
		const { provider, findings, syntax } = makeProvider();

		provider.dispose();

		expect(syntax.disposed).toBe(true);
		// extension.ts owns the collection it passed in and disposes it itself.
		expect(findings.disposed).toBe(false);
	});

	test("is safe to call twice", () => {
		const { provider } = makeProvider();
		provider.dispose();
		expect(() => provider.dispose()).not.toThrow();
	});

	test("cancels a debounced check that has not fired", async () => {
		const { provider } = makeProvider();
		openWorkspace(syntheticPath("synthetic", "workspace"));

		provider.scheduleWorkspaceSyntaxCheck(10);
		provider.dispose();
		await settle(60);

		expect(spawnCalls).toEqual([]);
	});

	test("ignores a check scheduled after disposal", async () => {
		const { provider } = makeProvider();
		openWorkspace(syntheticPath("synthetic", "workspace"));

		provider.dispose();
		provider.scheduleWorkspaceSyntaxCheck(5);
		await provider.runWorkspaceSyntaxCheck();
		await settle(40);

		expect(spawnCalls).toEqual([]);
	});

	test("kills an in-flight buf and publishes nothing from it", async () => {
		respond = () => ({
			code: 1,
			stderr: "proto/library.proto:1:1: broken",
			hang: true,
		});
		const { provider, syntax } = makeProvider();
		openWorkspace(syntheticPath("synthetic", "workspace"));

		const running = provider.runWorkspaceSyntaxCheck();
		await settle();
		provider.dispose();
		await running;

		expect(spawnedChildren[0].killed).toBe(true);
		// Output from a run that was cut short must not be published.
		expect(syntax.paths()).toEqual([]);
	});

	// `dispose()` tracks only the workspace `buf build` in `syntaxCheckProcess`.
	// A per-file api-linter run started by `lintDocument` or `lintUri` is never
	// held anywhere, so disposal neither kills it nor stops its `close` handler
	// from calling `set` on the findings collection — which extension.ts has
	// disposed by then. The real `DiagnosticCollection` throws on access after
	// disposal, and that throw lands in `lintUri`'s catch, which writes to the
	// same collection again, so it escapes as an unhandled rejection. The stub
	// collection tolerates writes after disposal, so this cannot be reproduced
	// here beyond observing that the child is left running.
	// Expected: disposal cancels the in-flight child and publishes nothing.
	test.skip("cancels an in-flight per-file lint", async () => {
		respond = () => ({ stdout: "[]", hang: true });
		const { provider, findings } = makeProvider();

		const running = provider.lintUri(protoUri(BOOK_PROTO), {
			binaryPath,
			options: options(),
		});
		await settle();
		provider.dispose();
		await running;

		expect(spawnedChildren[0].killed).toBe(true);
		expect(findings.paths()).toEqual([]);
	});

	test("drops a queued check when disposal happens mid-run", async () => {
		respond = () => ({ code: 0, hang: true });
		const { provider } = makeProvider();
		openWorkspace(syntheticPath("synthetic", "workspace"));

		const running = provider.runWorkspaceSyntaxCheck();
		await settle();
		await provider.runWorkspaceSyntaxCheck();
		provider.dispose();
		await running;
		await settle(600);

		expect(spawnCalls).toHaveLength(1);
	});
});

/** Lets every already-queued timer and microtask run. */
function settle(ms = 5): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
