/**
 * Smoke tests for the built webview bundles.
 *
 * These load the *built* `out/webview/*.js` rather than the components, which
 * is the point: a Svelte panel can typecheck, lint and bundle cleanly and still
 * throw on mount — a rune misused, a prop read before it exists, a component
 * imported but never compiled in. Nothing else in this suite executes that code
 * at all, so without these the first time it runs is in front of the user.
 *
 * They also pin the two facts the CSP depends on. A panel that reaches for the
 * network, or that calls `acquireVsCodeApi` more than once, fails in the host
 * and nowhere else.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Window } from "happy-dom";

/**
 * The built bundles, resolved from the repository root.
 *
 * `import.meta.dir` would be tidier but the host `tsconfig` compiles to
 * CommonJS, where it is a type error. `process.cwd()` is the repo root under
 * both `bun test` and the packaging script.
 */
const BUNDLE_DIR = path.resolve(process.cwd(), "out", "webview");

/** Messages the panel sent to its host during one mount. */
interface Harness {
	readonly window: Window;
	readonly posted: unknown[];
	readonly errors: string[];
	/** How many times the panel asked for the host API. */
	readonly acquired: () => number;
}

let harness: Harness | undefined;

/**
 * Mounts one built bundle in a DOM and returns what it did.
 *
 * The host API is stubbed rather than omitted: a panel that cannot acquire it
 * degrades by design, so leaving it out would test the fallback path instead of
 * the real one.
 */
async function mountBundle(entry: "details" | "registry"): Promise<Harness> {
	const file = path.join(BUNDLE_DIR, `${entry}.js`);
	if (!fs.existsSync(file)) {
		throw new Error(
			`${file} is missing — run \`node esbuild.js\` before this suite.`,
		);
	}

	const window = new Window({ url: "https://localhost/" });
	const posted: unknown[] = [];
	const errors: string[] = [];
	let acquired = 0;

	const scope = window as unknown as Record<string, unknown>;
	scope.acquireVsCodeApi = () => {
		acquired += 1;
		let stored: unknown;
		return {
			postMessage: (message: unknown) => posted.push(message),
			getState: () => stored,
			setState: (value: unknown) => {
				stored = value;
			},
		};
	};
	// Anything reaching the network would be blocked by the CSP in the host, so
	// a call here is a bug that must fail loudly rather than silently no-op.
	scope.fetch = () => {
		throw new Error("the panel must not use fetch");
	};

	window.addEventListener("error", (event) => {
		errors.push(String((event as unknown as { message: string }).message));
	});

	const code = fs.readFileSync(file, "utf8");
	// `eval` in the window's own realm, so the bundle sees that `document` and
	// `window`, not the test runner's globals.
	window.eval(code);
	await window.happyDOM.waitUntilComplete();

	return { window, posted, errors, acquired: () => acquired };
}

afterEach(async () => {
	await harness?.window.happyDOM.close();
	harness = undefined;
});

describe("details panel", () => {
	beforeEach(async () => {
		harness = await mountBundle("details");
	});

	test("mounts without throwing", () => {
		expect(harness?.errors).toEqual([]);
		expect(harness?.window.document.body.innerHTML.length).toBeGreaterThan(0);
	});

	test("acquires the host API exactly once", () => {
		// A second `acquireVsCodeApi()` throws in the real host. The bridge takes
		// the handle once and shares it; a component reaching for the global
		// directly is what this catches.
		expect(harness?.acquired()).toBe(1);
	});

	test("announces itself so the host sends the first payload", () => {
		expect(harness?.posted).toContainEqual({ type: "ready" });
	});

	test("shows an empty state before any symbol is selected", () => {
		const text = harness?.window.document.body.textContent ?? "";
		expect(text).toContain("Select a symbol");
	});

	test("renders a symbol the host sends, with its findings attributed", async () => {
		const window = harness?.window as Window;
		window.dispatchEvent(
			new window.MessageEvent("message", {
				data: {
					type: "details/update",
					detail: {
						name: "Book",
						fqn: "library.v1.Book",
						kind: "message",
						package: "library.v1",
						loc: { path: "/ws/library/v1/library.proto", line: 47 },
						isResource: true,
						fields: [
							{
								name: "create_time",
								type: "google.protobuf.Timestamp",
								number: 5,
								repeated: false,
								behaviors: [],
								loc: { path: "/ws/library/v1/library.proto", line: 57 },
								problemCount: 4,
							},
						],
						rpcs: [],
						enumValues: [],
						annotations: [
							{
								name: "google.api.resource",
								keys: [
									{ key: "type", value: '"library.googleapis.com/Book"' },
									{
										key: "singular",
										requiredBy: "core::0123::resource-singular",
										requiredByUrl:
											"https://linter.aip.dev/123/resource-singular",
									},
								],
							},
						],
						problems: [
							{
								ruleId: "core::0192::has-comments",
								message: 'Missing comment over "create_time".',
								docUrl: "https://linter.aip.dev/192/has-comments",
								severity: "error",
								loc: { path: "/ws/library/v1/library.proto", line: 57 },
								occurrences: 5,
								lines: [53, 54, 55, 56, 57],
							},
						],
						problemTotal: 18,
					},
				},
			}),
		);
		await window.happyDOM.waitUntilComplete();

		const text = window.document.body.textContent ?? "";
		expect(text).toContain("Book");
		expect(text).toContain("resource");
		expect(text).toContain("18 problems");
		expect(text).toContain("create_time");
		// The absent option key is the finding; a panel that renders only what
		// the file wrote could never show this line.
		expect(text).toContain("core::0123::resource-singular");
		// Collapsed occurrences keep their count rather than five identical rows.
		expect(text).toContain("×5");
		expect(text).toContain("lines 54-58");
		expect(harness?.errors).toEqual([]);
	});
});

describe("registry panel", () => {
	beforeEach(async () => {
		harness = await mountBundle("registry");
	});

	test("mounts without throwing", () => {
		expect(harness?.errors).toEqual([]);
		expect(harness?.window.document.body.innerHTML.length).toBeGreaterThan(0);
	});

	test("acquires the host API exactly once", () => {
		expect(harness?.acquired()).toBe(1);
	});

	test("announces itself so the host sends the first payload", () => {
		expect(harness?.posted).toContainEqual({ type: "ready" });
	});

	test("renders the dependency model the host sends", async () => {
		const window = harness?.window as Window;
		window.dispatchEvent(
			new window.MessageEvent("message", {
				data: {
					type: "registry/update",
					model: {
						modules: [
							{
								root: "/ws",
								deps: [
									{
										name: "buf.build/googleapis/googleapis",
										remote: "buf.build",
										owner: "googleapis",
										module: "googleapis",
										commit: "004180b77378443887d3b55cabc00384",
										protoCount: 94,
										declaredIn: "/ws/buf.yaml",
										state: "declared",
										update: {
											latestCommit: "c17df5b2000000000000000000000000",
											latestTime: "2026-04-14T00:00:00Z",
											behind: 8,
										},
									},
								],
							},
						],
						gen: [],
						undeclared: [],
						updatesChecked: true,
					},
				},
			}),
		);
		await window.happyDOM.waitUntilComplete();

		const text = window.document.body.textContent ?? "";
		expect(text).toContain("googleapis");
		expect(text).toContain("94 protos");
		// The commit is shown at buf's own width, not in full.
		expect(text).toContain("004180b7");
		// "8 behind" is the reason to open this panel at all.
		expect(text).toContain("8");
		expect(harness?.errors).toEqual([]);
	});

	test("surfaces an orphaned module rather than hiding it", async () => {
		const window = harness?.window as Window;
		window.dispatchEvent(
			new window.MessageEvent("message", {
				data: {
					type: "registry/update",
					model: {
						modules: [],
						gen: [],
						undeclared: [
							{
								name: "buf.build/the-protobuf-project/opentelementry",
								remote: "buf.build",
								owner: "the-protobuf-project",
								module: "opentelementry",
								commit: "c51a17a53c2d493c8ddb2a562c98d357",
								state: "orphaned",
								update: {
									latestCommit: "",
									latestTime: "",
									error:
										'a module named "buf.build/the-protobuf-project/opentelementry" does not exist',
								},
							},
						],
						updatesChecked: true,
					},
				},
			}),
		);
		await window.happyDOM.waitUntilComplete();

		const text = window.document.body.textContent ?? "";
		expect(text).toContain("opentelementry");
		expect(text).toContain("gone");
		expect(harness?.errors).toEqual([]);
	});

	test("reports a model that could not be built", async () => {
		const window = harness?.window as Window;
		window.dispatchEvent(
			new window.MessageEvent("message", {
				data: {
					type: "registry/update",
					model: {
						modules: [],
						gen: [],
						undeclared: [],
						updatesChecked: false,
						error: "no buf.yaml in this workspace",
					},
				},
			}),
		);
		await window.happyDOM.waitUntilComplete();

		const text = window.document.body.textContent ?? "";
		expect(text).toContain("Could not read buf configuration");
		expect(text).toContain("no buf.yaml in this workspace");
	});
});
