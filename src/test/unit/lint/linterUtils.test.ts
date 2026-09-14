/**
 * Tests for the pure core of the lint pipeline: output parsing, argv building
 * and the batch chunker.
 *
 * This is where the performance rewrite's second root cause lived. Linting used
 * to be one api-linter process per file plus a whole-workspace `buf build` per
 * file — 21.9 CPU-hours over the 9,280-proto reference corpus. It is now one
 * process per directory, chunked to stay clear of ARG_MAX, so the chunker's
 * invariants (nothing dropped, nothing duplicated, no argv over the cap, and
 * termination on a path longer than the cap) are load-bearing.
 *
 * The other thing worth pinning is the coordinate conversion. api-linter and buf
 * both count lines and columns from 1; VS Code counts from 0. An off-by-one here
 * moves every squiggle one line or one column and fails nothing else, so each
 * parser is checked against a hand-written position rather than a round trip.
 *
 * Nothing here spawns a process. `runBufSyntaxCheck` is the one function in the
 * module that only orchestrates a subprocess, and it is covered — through the
 * provider's workspace-wide replacement — in linterProvider.test.ts.
 */

import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Diagnostic } from "vscode";
import YAML from "yaml";
import type { LinterOptions, LinterProblem } from "../../../types";
import {
	buildLinterArgs,
	buildLinterBatches,
	disposeLinterBatchPlan,
	type LinterBatch,
	MAX_BATCH_ARGV_CHARS,
	MAX_BATCH_FILES,
	parseGenericOutput,
	parseLinterOutput,
	parseSyntaxErrorsForFile,
} from "../../../utils/linterUtils";
import {
	hasReferenceCorpus,
	listProtos,
	REFERENCE_PROTO_ROOT,
	syntheticPath,
} from "../support/fixtures";
import { DiagnosticSeverity, workspace } from "../support/vscode";

/** Options with every toggle off; tests vary one field at a time. */
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
 * @param overrides - Fields to replace, for the malformed-input cases
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

/** The documentation target VS Code opens for a rule id. */
function ruleDocTarget(diagnostic: Diagnostic): string {
	const code = diagnostic.code as { value: string; target: { fsPath: string } };
	// The stub's `Uri.parse` keeps the raw string, so `fsPath` is the url itself.
	return code.target.fsPath;
}

/** Characters one invocation costs: every argument plus the separator after it. */
function argvChars(batch: LinterBatch): number {
	return [...batch.baseArgs, ...batch.fileNames].reduce(
		(sum, arg) => sum + arg.length + 1,
		0,
	);
}

/** Runs `body` with the given folders reported as open, then restores. */
function withWorkspaceFolders(roots: string[], body: () => void): void {
	const original = workspace.workspaceFolders;
	workspace.workspaceFolders = roots.map((root) => ({
		uri: { fsPath: root },
	}));
	try {
		body();
	} finally {
		workspace.workspaceFolders = original;
	}
}

/** Runs `body` with `gapi` settings overridden, then restores. */
function withConfig(values: Record<string, unknown>, body: () => void): void {
	const original = workspace.getConfiguration;
	workspace.getConfiguration = (() => ({
		get: (key: string, fallback?: unknown) =>
			key in values ? values[key] : fallback,
	})) as typeof workspace.getConfiguration;
	try {
		body();
	} finally {
		workspace.getConfiguration = original;
	}
}

describe("parseLinterOutput", () => {
	test("converts the binary's 1-based positions to 0-based ranges", () => {
		const [diagnostic] = parseLinterOutput(
			jsonOutput([
				{ file_path: "book.proto", problems: [problem([12, 4], [12, 20])] },
			]),
		);
		expect(diagnostic.range.start.line).toBe(11);
		expect(diagnostic.range.start.character).toBe(3);
		expect(diagnostic.range.end.line).toBe(11);
		expect(diagnostic.range.end.character).toBe(19);
	});

	test("keeps a multi-line range spanning the lines the binary reported", () => {
		const [diagnostic] = parseLinterOutput(
			jsonOutput([
				{ file_path: "book.proto", problems: [problem([5, 1], [9, 2])] },
			]),
		);
		expect(diagnostic.range.start.line).toBe(4);
		expect(diagnostic.range.end.line).toBe(8);
	});

	test("clamps a position the binary reports as zero", () => {
		// 0 is out of range for a 1-based coordinate; the range must stay valid.
		const [diagnostic] = parseLinterOutput(
			jsonOutput([
				{ file_path: "book.proto", problems: [problem([0, 0], [0, 0])] },
			]),
		);
		expect(diagnostic.range.start.line).toBe(0);
		expect(diagnostic.range.start.character).toBe(0);
		expect(diagnostic.range.end.line).toBe(0);
		expect(diagnostic.range.end.character).toBe(0);
	});

	test("carries the message, source, severity and rule id", () => {
		const [diagnostic] = parseLinterOutput(
			jsonOutput([
				{ file_path: "book.proto", problems: [problem([1, 1], [1, 5])] },
			]),
		);
		expect(diagnostic.message).toBe("Message names should use UpperCamelCase.");
		expect(diagnostic.source).toBe("protobuf-aip-linter");
		expect(diagnostic.severity).toBe(DiagnosticSeverity.Error);
		expect((diagnostic.code as { value: string }).value).toBe(
			"core::0123::resource-annotation",
		);
		expect(ruleDocTarget(diagnostic)).toBe(
			"https://linter.aip.dev/123/resource-annotation",
		);
	});

	test("reports every problem of every result, in order", () => {
		const diagnostics = parseLinterOutput(
			jsonOutput([
				{
					file_path: "book.proto",
					problems: [
						problem([1, 1], [1, 2], { message: "first" }),
						problem([2, 1], [2, 2], { message: "second" }),
					],
				},
				{
					file_path: "shelf.proto",
					problems: [problem([3, 1], [3, 2], { message: "third" })],
				},
			]),
		);
		expect(diagnostics.map((d) => d.message)).toEqual([
			"first",
			"second",
			"third",
		]);
	});

	test("returns nothing for empty, blank or empty-array output", () => {
		expect(parseLinterOutput("")).toEqual([]);
		expect(parseLinterOutput("   \n\t\n")).toEqual([]);
		expect(parseLinterOutput("[]")).toEqual([]);
	});

	test("returns nothing for a clean file", () => {
		expect(
			parseLinterOutput(
				jsonOutput([{ file_path: "book.proto", problems: [] }]),
			),
		).toEqual([]);
		// The binary omits the key entirely when it has nothing to say.
		expect(parseLinterOutput('[{"file_path":"book.proto"}]')).toEqual([]);
	});

	test("ignores plain text printed around the JSON array", () => {
		const output = `Loading rules...\n${jsonOutput([
			{ file_path: "book.proto", problems: [problem([7, 3], [7, 8])] },
		])}\ndone\n`;
		const [diagnostic] = parseLinterOutput(output);
		expect(diagnostic.range.start.line).toBe(6);
	});

	test("tolerates CRLF around the JSON array", () => {
		const output = `Loading rules...\r\n${jsonOutput([
			{ file_path: "book.proto", problems: [problem([7, 3], [7, 8])] },
		])}\r\n`;
		expect(parseLinterOutput(output)).toHaveLength(1);
	});

	test("keeps unicode in the message intact", () => {
		const [diagnostic] = parseLinterOutput(
			jsonOutput([
				{
					file_path: "pátient.proto",
					problems: [problem([1, 1], [1, 2], { message: "naïve — ✨ 資源" })],
				},
			]),
		);
		expect(diagnostic.message).toBe("naïve — ✨ 資源");
	});

	test("still reports a problem that carries no rule id", () => {
		const [diagnostic] = parseLinterOutput(
			jsonOutput([
				{
					file_path: "book.proto",
					problems: [
						problem([2, 1], [2, 9], {
							rule_id: undefined as unknown as string,
							message: "unnamed warning",
						}),
					],
				},
			]),
		);
		expect(diagnostic.message).toBe("unnamed warning");
		expect((diagnostic.code as { value: string }).value).toBeUndefined();
	});

	test("falls back to the text parser when there is no JSON array", () => {
		const [diagnostic] = parseLinterOutput(
			"book.proto:12:4: syntax error: unexpected '}'",
		);
		expect(diagnostic.source).toBe("protobuf-aip-linter (syntax)");
		expect(diagnostic.range.start.line).toBe(11);
		expect(diagnostic.range.start.character).toBe(3);
	});

	test("falls back to the text parser when the JSON is truncated", () => {
		// A killed process leaves half an array behind; the syntax line after it
		// is still worth surfacing.
		const diagnostics = parseLinterOutput(
			'[{"file_path":"book.proto","problems":[{"mess\nbook.proto:3:5: unexpected EOF',
		);
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0].message).toBe("unexpected EOF");
	});

	test("rewrites the rule documentation host when one is configured", () => {
		withConfig({ rulesDocumentationEndpoint: "http://localhost:8080" }, () => {
			const [diagnostic] = parseLinterOutput(
				jsonOutput([
					{ file_path: "book.proto", problems: [problem([1, 1], [1, 2])] },
				]),
			);
			expect(ruleDocTarget(diagnostic)).toBe(
				"http://localhost:8080/123/resource-annotation",
			);
		});
	});

	test("leaves the documentation uri alone when the endpoint is the default", () => {
		withConfig({ rulesDocumentationEndpoint: "" }, () => {
			const [diagnostic] = parseLinterOutput(
				jsonOutput([
					{ file_path: "book.proto", problems: [problem([1, 1], [1, 2])] },
				]),
			);
			expect(ruleDocTarget(diagnostic)).toBe(
				"https://linter.aip.dev/123/resource-annotation",
			);
		});
	});

	// One problem missing `location` throws inside the loop that builds
	// diagnostics, which the outer try/catch turns into "parse the whole thing as
	// text" — and the text parser matches nothing in JSON. Every well-formed
	// finding in the same run is therefore discarded, including findings for other
	// files in a batch. A `[` in a log line before the array (`[INFO] …`) loses the
	// run the same way, because the extractor starts the slice at the first `[`.
	// Expected: a malformed entry is skipped and its siblings still report.
	test("keeps the well-formed problems when one entry is malformed", () => {
		const diagnostics = parseLinterOutput(
			`[{"file_path":"book.proto","problems":[{"message":"broken"},${JSON.stringify(
				problem([4, 2], [4, 6], { message: "intact" }),
			)}]}]`,
		);
		expect(diagnostics.map((d) => d.message)).toEqual(["intact"]);
	});
});

describe("parseGenericOutput", () => {
	test("converts file:line:col to a 0-based range", () => {
		const [diagnostic] = parseGenericOutput(
			"proto/library.proto:12:4: syntax error: unexpected identifier",
		);
		expect(diagnostic.range.start.line).toBe(11);
		expect(diagnostic.range.start.character).toBe(3);
		expect(diagnostic.message).toBe("syntax error: unexpected identifier");
		expect(diagnostic.source).toBe("protobuf-aip-linter (syntax)");
		expect(diagnostic.severity).toBe(DiagnosticSeverity.Error);
	});

	test("ends the range at a fixed column, past any real line", () => {
		const [diagnostic] = parseGenericOutput("a.proto:1:1: oops");
		expect(diagnostic.range.end.line).toBe(0);
		expect(diagnostic.range.end.character).toBe(200);
	});

	test("strips a Go log timestamp prefix", () => {
		const [diagnostic] = parseGenericOutput(
			"2026/02/20 14:49:31 proto/library.proto:12:4: syntax error",
		);
		expect(diagnostic.range.start.line).toBe(11);
		expect(diagnostic.message).toBe("syntax error");
	});

	test("reports one diagnostic per matching line and ignores the rest", () => {
		const diagnostics = parseGenericOutput(
			[
				"Failure: build failed",
				"a.proto:1:1: first",
				"",
				"not a diagnostic at all",
				"b.proto:2:2: second",
			].join("\n"),
		);
		expect(diagnostics.map((d) => d.message)).toEqual(["first", "second"]);
	});

	// The output is split on "\n", so a CRLF line keeps its "\r" — and `.` never
	// matches a carriage return while `$` (no `m` flag) only matches the true end
	// of the string, so the pattern fails on every line of a CRLF stream. Windows
	// therefore reports no syntax errors at all. The same regex is copied into
	// `parseSyntaxErrorsForFile` and into linterProvider's by-file parser, so all
	// three go blind together.
	// Expected: the carriage return is stripped and the line reports as it does
	// with LF endings.
	test("trims the carriage return from CRLF output", () => {
		const [diagnostic] = parseGenericOutput("a.proto:1:1: unexpected EOF\r\n");
		expect(diagnostic.message).toBe("unexpected EOF");
	});

	test("handles a path with spaces and unicode", () => {
		const [diagnostic] = parseGenericOutput("my protos/pátient.proto:2:3: bad");
		expect(diagnostic.range.start.line).toBe(1);
		expect(diagnostic.range.start.character).toBe(2);
	});

	test("returns nothing for empty output", () => {
		expect(parseGenericOutput("")).toEqual([]);
		expect(parseGenericOutput("\n\n")).toEqual([]);
	});

	// A column of 0 means "the whole line" for some protoc builds. This parser
	// drops such a report entirely (`colNum >= 0` fails after the -1), while
	// `parseSyntaxErrorsForFile` and the provider's by-file parser both clamp it
	// to 0 and report. Expected: clamp here too, rather than silently losing the
	// error.
	test("clamps a column of zero instead of dropping the report", () => {
		const [diagnostic] = parseGenericOutput("a.proto:7:0: unterminated string");
		expect(diagnostic.range.start.line).toBe(6);
		expect(diagnostic.range.start.character).toBe(0);
	});

	// `([^:]+)` cannot match a Windows absolute path, so every line of a
	// `buf build` that prints one is skipped and the file shows no syntax errors
	// at all. All three parsers in the pipeline share the pattern.
	// Expected: a drive letter is part of the path, not the line/column split.
	test("matches a Windows absolute path", () => {
		const diagnostics = parseGenericOutput(
			"C:\\src\\proto\\library.proto:12:4: syntax error",
		);
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0].range.start.line).toBe(11);
	});
});

describe("parseSyntaxErrorsForFile", () => {
	const cwd = syntheticPath("work", "repo");
	const current = path.join(cwd, "proto", "library.proto");

	test("keeps only the errors for the requested file", () => {
		const diagnostics = parseSyntaxErrorsForFile(
			[
				"proto/library.proto:12:4: unexpected '}'",
				"proto/other.proto:3:1: unrelated",
				"proto/library.proto:40:9: expected ';'",
			].join("\n"),
			current,
			cwd,
		);
		expect(diagnostics.map((d) => d.message)).toEqual([
			"unexpected '}'",
			"expected ';'",
		]);
		expect(diagnostics.map((d) => d.range.start.line)).toEqual([11, 39]);
	});

	test("matches an absolute path in the output", () => {
		const diagnostics = parseSyntaxErrorsForFile(
			`${current}:5:2: unexpected token`,
			current,
			cwd,
		);
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0].range.start.character).toBe(1);
	});

	test("clamps a column of zero", () => {
		const [diagnostic] = parseSyntaxErrorsForFile(
			"proto/library.proto:7:0: unterminated string",
			current,
			cwd,
		);
		expect(diagnostic.range.start.line).toBe(6);
		expect(diagnostic.range.start.character).toBe(0);
	});

	test("ends the range past the column it starts at", () => {
		const [wide] = parseSyntaxErrorsForFile(
			"proto/library.proto:1:400: far right",
			current,
			cwd,
		);
		expect(wide.range.end.character).toBe(400);
		const [narrow] = parseSyntaxErrorsForFile(
			"proto/library.proto:1:2: near left",
			current,
			cwd,
		);
		expect(narrow.range.end.character).toBe(200);
	});

	test("resolves a path with spaces and unicode against the cwd", () => {
		const spaced = path.join(cwd, "my protos", "pátient file.proto");
		const diagnostics = parseSyntaxErrorsForFile(
			"my protos/pátient file.proto:2:3: bad field",
			spaced,
			cwd,
		);
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0].message).toBe("bad field");
	});

	test("strips a Go log timestamp prefix", () => {
		const diagnostics = parseSyntaxErrorsForFile(
			"2026/02/20 14:49:31 proto/library.proto:12:4: unexpected '}'",
			current,
			cwd,
		);
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0].message).toBe("unexpected '}'");
	});

	// Same regex, same CRLF blindness as `parseGenericOutput` above.
	// Expected: a CRLF stream reports exactly as an LF one does.
	test("tolerates CRLF line endings", () => {
		expect(
			parseSyntaxErrorsForFile(
				"proto/library.proto:12:4: unexpected '}'\r\n",
				current,
				cwd,
			),
		).toHaveLength(1);
	});

	test("returns nothing for empty or unmatched output", () => {
		expect(parseSyntaxErrorsForFile("", current, cwd)).toEqual([]);
		expect(
			parseSyntaxErrorsForFile("Failure: build failed", current, cwd),
		).toEqual([]);
	});

	// A line number of 0 yields -1 after the 1-based conversion, and the real
	// `vscode.Position` rejects a negative line, so this throws inside the `close`
	// handler that `runBufSyntaxCheck` parses in — leaving its promise unsettled.
	// The provider's by-file parser skips such a line instead (linterProvider.ts).
	// Expected: skip it here too.
	test("skips a report on line zero", () => {
		expect(
			parseSyntaxErrorsForFile(
				"proto/library.proto:0:1: file is empty",
				current,
				cwd,
			),
		).toEqual([]);
	});
});

describe("buildLinterArgs", () => {
	let root: string;
	let protoDir: string;
	let protoFile: string;

	beforeAll(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "gapi-args-"));
		protoDir = path.join(root, "pkg", "v1");
		fs.mkdirSync(protoDir, { recursive: true });
		protoFile = path.join(protoDir, "book.proto");
		fs.writeFileSync(protoFile, 'syntax = "proto3";\n', "utf8");
	});

	afterAll(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	test("passes the base name last and runs from the file's directory", () => {
		const { args, workingDir, fileName } = buildLinterArgs(
			protoFile,
			options(),
		);
		expect(fileName).toBe("book.proto");
		expect(args[args.length - 1]).toBe("book.proto");
		expect(workingDir).toBe(protoDir);
	});

	test("always asks for JSON, which is the format the parser expects", () => {
		const { args } = buildLinterArgs(protoFile, options());
		expect(args[args.length - 3]).toBe("--output-format");
		expect(args[args.length - 2]).toBe("json");
	});

	test("puts the file's own directory on the proto path", () => {
		const { args } = buildLinterArgs(protoFile, options());
		expect(args).toContain("--proto-path");
		expect(args).toContain(protoDir);
	});

	test("emits one flag per disabled and enabled rule, in order", () => {
		const { args } = buildLinterArgs(
			protoFile,
			options({
				disableRules: ["core::0192::has-comments", "core::0131::request-name"],
				enableRules: ["custom::rule"],
			}),
		);
		const flags = args.filter(
			(_arg, at) =>
				args[at - 1] === "--disable-rule" || args[at - 1] === "--enable-rule",
		);
		expect(flags).toEqual([
			"core::0192::has-comments",
			"core::0131::request-name",
			"custom::rule",
		]);
		expect(args.filter((a) => a === "--disable-rule")).toHaveLength(2);
		expect(args.filter((a) => a === "--enable-rule")).toHaveLength(1);
	});

	test("adds --set-exit-status only when asked", () => {
		expect(buildLinterArgs(protoFile, options()).args).not.toContain(
			"--set-exit-status",
		);
		expect(
			buildLinterArgs(protoFile, options({ setExitStatus: true })).args,
		).toContain("--set-exit-status");
	});

	test("adds the workspace root to the proto path, once", () => {
		withWorkspaceFolders([root], () => {
			const { args } = buildLinterArgs(protoFile, options());
			expect(args.filter((a) => a === root)).toHaveLength(1);
		});
	});

	test("expands ${workspaceFolder} in a configured proto path", () => {
		withWorkspaceFolders([root], () => {
			const { args } = buildLinterArgs(
				protoFile,
				options({ protoPath: ["${workspaceFolder}/pkg"] }),
			);
			expect(args).toContain(path.join(root, "pkg"));
		});
	});

	test("drops a configured proto path that does not exist", () => {
		const missing = path.join(root, "nope");
		const { args } = buildLinterArgs(
			protoFile,
			options({ protoPath: [missing] }),
		);
		expect(args).not.toContain(missing);
	});

	test("finds .api-linter.yaml by walking up to the workspace root", () => {
		const configPath = path.join(root, ".api-linter.yaml");
		fs.writeFileSync(configPath, "- disabled_rules:\n    - core::0192\n");
		try {
			withWorkspaceFolders([root], () => {
				const { args, tempConfigPath } = buildLinterArgs(protoFile, options());
				expect(args[args.indexOf("--config") + 1]).toBe(configPath);
				// An array config is already the shape api-linter wants.
				expect(tempConfigPath).toBeNull();
			});
		} finally {
			fs.rmSync(configPath, { force: true });
		}
	});

	test("wraps a single-map config in an array in a temp file", () => {
		const configPath = path.join(root, ".api-linter.yaml");
		fs.writeFileSync(configPath, "disabled_rules:\n  - core::0192\n");
		let temp: string | null = null;
		try {
			withWorkspaceFolders([root], () => {
				const { args, tempConfigPath } = buildLinterArgs(protoFile, options());
				temp = tempConfigPath;
				expect(tempConfigPath).not.toBeNull();
				expect(args[args.indexOf("--config") + 1]).toBe(
					tempConfigPath as string,
				);
				const wrapped = YAML.parse(
					fs.readFileSync(tempConfigPath as string, "utf8"),
				);
				expect(wrapped).toEqual([{ disabled_rules: ["core::0192"] }]);
			});
		} finally {
			fs.rmSync(configPath, { force: true });
			if (temp) {
				fs.rmSync(temp, { force: true });
			}
		}
	});

	test("does not look for a config above the workspace root", () => {
		const configPath = path.join(root, ".api-linter.yaml");
		fs.writeFileSync(configPath, "- disabled_rules: []\n");
		try {
			// The open folder is the leaf, so the config one level up is out of scope.
			withWorkspaceFolders([protoDir], () => {
				const { args } = buildLinterArgs(protoFile, options());
				expect(args).not.toContain("--config");
			});
		} finally {
			fs.rmSync(configPath, { force: true });
		}
	});

	// Everything below is what makes a config's path scoping mean anything.
	// api-linter matches included_paths and excluded_paths against the file name
	// it was handed, so a bare base name passed from the file's own directory
	// made every directory pattern a guaranteed miss: no glob naming a folder
	// can match "book.proto". The run has to happen from the directory that owns
	// the config, with a path relative to it, or path scoping silently does
	// nothing -- which is worse than failing, because the config looks right.
	describe("with a config governing the file", () => {
		let configPath: string;

		beforeEach(() => {
			configPath = path.join(root, ".api-linter.yaml");
			fs.writeFileSync(
				configPath,
				'- included_paths:\n    - "pkg/**"\n  disabled_rules:\n    - all\n',
			);
		});

		afterEach(() => {
			fs.rmSync(configPath, { force: true });
		});

		test("runs from the config's directory", () => {
			withWorkspaceFolders([root], () => {
				const { workingDir } = buildLinterArgs(protoFile, options());
				expect(workingDir).toBe(root);
			});
		});

		test("names the file relative to that directory, in posix form", () => {
			withWorkspaceFolders([root], () => {
				const { args, fileName } = buildLinterArgs(protoFile, options());
				expect(fileName).toBe("pkg/v1/book.proto");
				expect(args[args.length - 1]).toBe("pkg/v1/book.proto");
			});
		});

		test("puts the config's directory on the proto path so that name resolves", () => {
			withWorkspaceFolders([root], () => {
				const { args } = buildLinterArgs(protoFile, options());
				const roots = args.filter(
					(_arg, at) => args[at - 1] === "--proto-path",
				);
				expect(roots[0]).toBe(root);
			});
		});

		test("keeps the file's own directory on the proto path for sibling imports", () => {
			withWorkspaceFolders([root], () => {
				const { args } = buildLinterArgs(protoFile, options());
				expect(args).toContain(protoDir);
			});
		});

		test("falls back to the base name for a config outside the file's tree", () => {
			// `gapi.configPath` can name a shared file anywhere; with no workspace
			// folder to relativize against there is nothing to be relative to.
			const outside = fs.mkdtempSync(path.join(os.tmpdir(), "gapi-cfg-"));
			const shared = path.join(outside, ".api-linter.yaml");
			fs.writeFileSync(shared, "- disabled_rules: []\n");
			try {
				const { workingDir, fileName } = buildLinterArgs(
					protoFile,
					options({ configPath: shared }),
				);
				expect(workingDir).toBe(protoDir);
				expect(fileName).toBe("book.proto");
			} finally {
				fs.rmSync(outside, { recursive: true, force: true });
			}
		});

		test("relativizes against the workspace root for an out-of-tree config", () => {
			const outside = fs.mkdtempSync(path.join(os.tmpdir(), "gapi-cfg-"));
			const shared = path.join(outside, ".api-linter.yaml");
			fs.writeFileSync(shared, "- disabled_rules: []\n");
			try {
				withWorkspaceFolders([root], () => {
					const { workingDir, fileName } = buildLinterArgs(
						protoFile,
						options({ configPath: shared }),
					);
					expect(workingDir).toBe(root);
					expect(fileName).toBe("pkg/v1/book.proto");
				});
			} finally {
				fs.rmSync(outside, { recursive: true, force: true });
			}
		});
	});
});

describe("buildLinterBatches", () => {
	/** A directory that never exists, so no config or proto-path probing hits it. */
	const synthetic = syntheticPath("synthetic", "protos");

	test("documents the caps it chunks against", () => {
		expect(MAX_BATCH_FILES).toBe(400);
		expect(MAX_BATCH_ARGV_CHARS).toBe(100_000);
	});

	test("returns nothing for no files", () => {
		const plan = buildLinterBatches([], options());
		expect(plan.batches).toEqual([]);
		expect(plan.tempConfigPaths).toEqual([]);
	});

	test("runs one process per directory, not one per file", () => {
		const files = [
			path.join(synthetic, "a", "one.proto"),
			path.join(synthetic, "a", "two.proto"),
			path.join(synthetic, "a", "three.proto"),
			path.join(synthetic, "b", "four.proto"),
		];
		const { batches } = buildLinterBatches(files, options());
		expect(batches).toHaveLength(2);
		expect(batches[0].workingDir).toBe(path.join(synthetic, "a"));
		expect(batches[0].fileNames).toEqual([
			"one.proto",
			"two.proto",
			"three.proto",
		]);
		expect(batches[1].fileNames).toEqual(["four.proto"]);
	});

	test("passes base names alongside the absolute path they came from", () => {
		const files = [path.join(synthetic, "a", "one.proto")];
		const [batch] = buildLinterBatches(files, options()).batches;
		expect(batch.fileNames).toEqual(["one.proto"]);
		expect(batch.filePaths).toEqual([path.join(synthetic, "a", "one.proto")]);
		expect(batch.baseArgs).not.toContain("one.proto");
	});

	test("resolves a relative path against the process cwd", () => {
		const [batch] = buildLinterBatches(
			["pkg/v1/book.proto"],
			options(),
		).batches;
		expect(batch.filePaths).toEqual([path.resolve("pkg/v1/book.proto")]);
		expect(batch.workingDir).toBe(path.resolve("pkg/v1"));
	});

	test("splits a directory at the file-count cap", () => {
		const files = Array.from({ length: MAX_BATCH_FILES + 1 }, (_v, at) =>
			path.join(synthetic, "big", `f${at}.proto`),
		);
		const { batches } = buildLinterBatches(files, options());
		expect(batches).toHaveLength(2);
		expect(batches[0].fileNames).toHaveLength(MAX_BATCH_FILES);
		expect(batches[1].fileNames).toHaveLength(1);
	});

	test("splits a directory at the argv character cap", () => {
		// A batch spends argv on basenames, not whole paths -- the command runs
		// from the shared working directory. So the character cap only binds
		// before the file-count cap when basenames are far longer than any real
		// filesystem permits: 400 files of even a 255-char basename is ~102k,
		// barely over the 100k cap, and a realistic ~20-char basename puts 400
		// files at ~8k. These names are deliberately unreal, to exercise the
		// guard in isolation; in practice the file-count cap is what splits.
		const name = "z".repeat(1000);
		const files = Array.from({ length: 150 }, (_v, at) =>
			path.join(synthetic, "long", `${name}-${at}.proto`),
		);
		const { batches } = buildLinterBatches(files, options());
		expect(batches.length).toBeGreaterThan(1);
		for (const batch of batches) {
			expect(argvChars(batch)).toBeLessThanOrEqual(MAX_BATCH_ARGV_CHARS);
		}
		// Proves the split was the character cap and not the file count.
		expect(batches.every((b) => b.fileNames.length < MAX_BATCH_FILES)).toBe(
			true,
		);
	});

	test("loses and duplicates nothing when it splits", () => {
		const files = Array.from({ length: 1000 }, (_v, at) =>
			path.join(synthetic, at % 2 === 0 ? "even" : "odd", `f${at}.proto`),
		);
		const { batches } = buildLinterBatches(files, options());
		const seen = batches.flatMap((b) => b.filePaths);
		expect(seen).toHaveLength(files.length);
		expect(new Set(seen).size).toBe(files.length);
		expect([...seen].sort()).toEqual([...files].sort());
	});

	test("keeps a single over-long path in its own batch rather than looping", () => {
		// Nothing can be split below one file argument, so the batch is allowed to
		// exceed the cap; what matters is that it terminates and keeps the path.
		const huge = path.join(
			synthetic,
			"huge",
			`${"n".repeat(MAX_BATCH_ARGV_CHARS + 10)}.proto`,
		);
		const { batches } = buildLinterBatches(
			[huge, path.join(synthetic, "huge", "small.proto")],
			options(),
		);
		expect(batches).toHaveLength(2);
		expect(batches[0].fileNames).toHaveLength(1);
		expect(batches[0].filePaths[0]).toBe(huge);
		expect(batches[1].fileNames).toEqual(["small.proto"]);
	});

	test("gives every batch of a directory the same flags", () => {
		const files = Array.from({ length: MAX_BATCH_FILES + 5 }, (_v, at) =>
			path.join(synthetic, "shared", `f${at}.proto`),
		);
		const { batches } = buildLinterBatches(files, options());
		expect(batches[0].baseArgs).toEqual(batches[1].baseArgs);
		expect(batches[0].workingDir).toBe(batches[1].workingDir);
	});

	test.skipIf(!hasReferenceCorpus())(
		"chunks the 9,280-proto corpus into a few hundred invocations",
		() => {
			const root = REFERENCE_PROTO_ROOT;
			if (!root) {
				return;
			}
			const protos = listProtos(root);
			expect(protos.length).toBeGreaterThan(9000);

			const plan = buildLinterBatches(protos, options());
			try {
				const seen = plan.batches.flatMap((b) => b.filePaths);
				expect(seen).toHaveLength(protos.length);
				expect(new Set(seen).size).toBe(protos.length);

				for (const batch of plan.batches) {
					expect(batch.fileNames).toHaveLength(batch.filePaths.length);
					expect(batch.fileNames.length).toBeLessThanOrEqual(MAX_BATCH_FILES);
					expect(argvChars(batch)).toBeLessThanOrEqual(MAX_BATCH_ARGV_CHARS);
					// A batch never mixes directories: the proto path derives from one.
					expect(
						new Set(batch.filePaths.map((p) => path.dirname(p))).size,
					).toBe(1);
					for (const [at, filePath] of batch.filePaths.entries()) {
						// The argument is whatever the cwd makes it, base name or
						// root-relative path; either way it has to name this file.
						expect(path.resolve(batch.workingDir, batch.fileNames[at])).toBe(
							path.resolve(filePath),
						);
					}
				}

				// The rewrite's whole point: processes scale with directories, not files.
				expect(plan.batches.length).toBeLessThan(protos.length / 5);
			} finally {
				disposeLinterBatchPlan(plan);
			}
		},
	);
});

describe("disposeLinterBatchPlan", () => {
	test("removes the temp configs the plan created", () => {
		const temp = path.join(
			os.tmpdir(),
			`gapi-dispose-${process.pid}-${Date.now()}.yaml`,
		);
		fs.writeFileSync(temp, "- {}\n", "utf8");
		disposeLinterBatchPlan({ batches: [], tempConfigPaths: [temp] });
		expect(fs.existsSync(temp)).toBe(false);
	});

	test("tolerates a temp config that is already gone", () => {
		expect(() =>
			disposeLinterBatchPlan({
				batches: [],
				tempConfigPaths: [path.join(os.tmpdir(), "gapi-never-written.yaml")],
			}),
		).not.toThrow();
	});
});
