/**
 * The whole-workspace API report.
 *
 * Everything the Details panel shows for one symbol, computed for every symbol
 * and written as Markdown. The output is a file rather than a webview for two
 * reasons: VS Code's own Markdown preview already renders it, including
 * ```mermaid fences when a Mermaid extension is installed, so the diagrams cost
 * this extension nothing; and a file can be committed, reviewed in a pull
 * request, or pasted into an issue, which is where API review actually happens.
 *
 * Reads the index and the diagnostic collection. No document is ever opened.
 */

import * as path from "node:path";
import type * as vscode from "vscode";
import type { IndexedSymbol, ProtoIndex } from "../index/types";
import { splitRpcDetail } from "../protoScanner";
import {
	attributeProblems,
	type FindingLike,
	symbolSpan,
} from "./symbolDetail";

/** Services listed in full before the report switches to a summary table. */
const MAX_DETAILED_SERVICES = 60;

/** Messages listed in the index table. */
const MAX_LISTED_MESSAGES = 400;

/** Rows in the "most reused" table. */
const MAX_SHARED = 20;

/** Protobuf scalars, which are never worth an edge in a dependency graph. */
const SCALARS = new Set([
	"double",
	"float",
	"int32",
	"int64",
	"uint32",
	"uint64",
	"sint32",
	"sint64",
	"fixed32",
	"fixed64",
	"sfixed32",
	"sfixed64",
	"bool",
	"string",
	"bytes",
]);

/** What the report was built from and how much of it was shown. */
export interface ReportStats {
	readonly services: number;
	readonly rpcs: number;
	readonly messages: number;
	readonly enums: number;
	readonly files: number;
	readonly packages: number;
	readonly problems: number;
}

/** A finished report. */
export interface ApiReport {
	readonly markdown: string;
	readonly stats: ReportStats;
}

/** Options for {@link buildApiReport}. */
export interface ReportOptions {
	/** Title line. Defaults to the workspace folder name. */
	readonly title?: string;
	/** Restrict to symbols whose package starts with one of these. */
	readonly packages?: readonly string[];
	/** Aborts between sections. */
	readonly isCancelled?: () => boolean;
}

/** Escapes the characters that would break a Markdown table cell. */
function cell(value: string): string {
	return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/** The last dotted segment of a type name. */
function shortType(type: string): string {
	const bare = type.replace(/^\./, "");
	const cut = bare.lastIndexOf(".");
	return cut === -1 ? bare : bare.slice(cut + 1);
}

/** A Mermaid-safe node id. */
function nodeId(value: string): string {
	return value.replace(/[^\w]/g, "_");
}

/** First sentence of a doc comment, for a one-line summary column. */
function firstSentence(doc: string | undefined): string {
	if (!doc) {
		return "";
	}
	const flat = doc.replace(/\s+/g, " ").trim();
	const stop = flat.indexOf(". ");
	return stop === -1 ? flat : flat.slice(0, stop + 1);
}

/** Every diagnostic this extension published, grouped by file path. */
function diagnosticsByPath(
	diagnostics: vscode.DiagnosticCollection,
): Map<string, FindingLike[]> {
	const byPath = new Map<string, FindingLike[]>();
	diagnostics.forEach((uri, list) => {
		byPath.set(uri.fsPath, [...list] as unknown as FindingLike[]);
	});
	return byPath;
}

/**
 * Builds the report.
 *
 * @param index - The workspace index
 * @param diagnostics - Findings to attribute to symbols
 * @param options - Title, package filter and cancellation
 * @returns The Markdown and what it was built from
 */
export function buildApiReport(
	index: ProtoIndex,
	diagnostics: vscode.DiagnosticCollection,
	options: ReportOptions = {},
): ApiReport {
	const files = index.files();
	const findings = diagnosticsByPath(diagnostics);
	const wanted = options.packages;

	const inScope = (symbol: IndexedSymbol): boolean => {
		if (!wanted || wanted.length === 0) {
			return true;
		}
		const file = index.file(symbol.fileId);
		const pkg = file?.packageName ?? "";
		return wanted.some(
			(prefix) => pkg === prefix || pkg.startsWith(`${prefix}.`),
		);
	};

	/* -------------------------------------------------------------- *
	 * Gather
	 * -------------------------------------------------------------- */

	const services: IndexedSymbol[] = [];
	const messages: IndexedSymbol[] = [];
	const enums: IndexedSymbol[] = [];
	const rpcsByService = new Map<string, IndexedSymbol[]>();
	const symbolsByFile = new Map<number, readonly IndexedSymbol[]>();
	const packages = new Set<string>();

	for (const file of files) {
		if (options.isCancelled?.()) {
			break;
		}
		const symbols = index.symbolsInFile(file.id);
		symbolsByFile.set(file.id, symbols);
		for (const symbol of symbols) {
			if (!inScope(symbol)) {
				continue;
			}
			if (file.packageName) {
				packages.add(file.packageName);
			}
			if (symbol.kind === "service") {
				services.push(symbol);
			} else if (symbol.kind === "message") {
				messages.push(symbol);
			} else if (symbol.kind === "enum") {
				enums.push(symbol);
			} else if (symbol.kind === "rpc" && symbol.parentFqn) {
				const bucket = rpcsByService.get(symbol.parentFqn);
				if (bucket) {
					bucket.push(symbol);
				} else {
					rpcsByService.set(symbol.parentFqn, [symbol]);
				}
			}
		}
	}

	services.sort((a, b) => a.fqn.localeCompare(b.fqn));
	messages.sort((a, b) => a.fqn.localeCompare(b.fqn));
	enums.sort((a, b) => a.fqn.localeCompare(b.fqn));

	/** Findings inside one symbol's span. */
	const problemsOf = (symbol: IndexedSymbol): number => {
		const file = index.file(symbol.fileId);
		if (!file) {
			return 0;
		}
		const list = findings.get(file.path);
		if (!list || list.length === 0) {
			return 0;
		}
		const siblings = symbolsByFile.get(file.id) ?? [];
		// A large line count is fine here: the span only needs an upper bound
		// when the symbol is the last in its file.
		const span = symbolSpan(siblings, symbol, Number.MAX_SAFE_INTEGER);
		return attributeProblems(list, span, file.path).reduce(
			(sum, problem) => sum + problem.occurrences,
			0,
		);
	};

	let totalProblems = 0;
	for (const list of findings.values()) {
		totalProblems += list.length;
	}

	/* -------------------------------------------------------------- *
	 * Write
	 * -------------------------------------------------------------- */

	const out: string[] = [];
	const title = options.title ?? "Proto API";
	const totalRpcs = [...rpcsByService.values()].reduce(
		(sum, list) => sum + list.length,
		0,
	);

	out.push(`# ${title}`, "");
	out.push(
		"> Generated by the Protobuf AIP Linter from the workspace symbol index.",
		"> Diagrams are Mermaid; VS Code renders them in the Markdown preview with a",
		"> Mermaid extension installed, and GitHub renders them natively.",
		"",
	);

	out.push("## At a glance", "");
	out.push("| | Count |", "| --- | ---: |");
	out.push(`| Packages | ${packages.size} |`);
	out.push(`| Files | ${files.length} |`);
	out.push(`| Services | ${services.length} |`);
	out.push(`| RPCs | ${totalRpcs} |`);
	out.push(`| Messages | ${messages.length} |`);
	out.push(`| Enums | ${enums.length} |`);
	out.push(`| Lint findings | ${totalProblems} |`);
	out.push("");

	/* --- Services --------------------------------------------------- */

	if (services.length > 0) {
		out.push("## Services", "");
		const detailed = services.slice(0, MAX_DETAILED_SERVICES);

		for (const service of detailed) {
			if (options.isCancelled?.()) {
				break;
			}
			const file = index.file(service.fileId);
			const rpcs = (rpcsByService.get(service.fqn) ?? []).slice();
			rpcs.sort((a, b) => a.line - b.line);
			const problems = problemsOf(service);

			out.push(`### ${service.name}`, "");
			out.push(
				`\`${service.fqn}\` · [\`${file ? path.basename(file.path) : "?"}:${service.line + 1}\`](${
					file ? `${path.basename(file.path)}#L${service.line + 1}` : "#"
				})${problems > 0 ? ` · **${problems} finding(s)**` : ""}`,
				"",
			);
			if (service.doc) {
				out.push(service.doc.replace(/\s+/g, " ").trim(), "");
			}

			if (rpcs.length > 0) {
				out.push("| RPC | Request | Response | Findings |");
				out.push("| --- | --- | --- | ---: |");
				for (const rpc of rpcs) {
					const { requestType, responseType } = splitRpcDetail(rpc.detail);
					const count = problemsOf(rpc);
					out.push(
						`| \`${cell(rpc.name)}\` | \`${cell(shortType(requestType))}\` | \`${cell(
							shortType(responseType),
						)}\` | ${count > 0 ? `**${count}**` : "—"} |`,
					);
				}
				out.push("");

				// The graph earns its place here: a table cannot show that five
				// methods return the same message, which is the fact a reviewer
				// is looking for.
				out.push("```mermaid", "graph LR");
				out.push(`  ${nodeId(service.fqn)}["${service.name}"]`);
				for (const rpc of rpcs) {
					const { requestType, responseType } = splitRpcDetail(rpc.detail);
					const rpcNode = `${nodeId(service.fqn)}_${nodeId(rpc.name)}`;
					out.push(`  ${nodeId(service.fqn)} --> ${rpcNode}["${rpc.name}"]`);
					if (requestType) {
						out.push(
							`  ${rpcNode} --> ${nodeId(requestType)}["${shortType(requestType)}"]`,
						);
					}
					if (responseType) {
						out.push(
							`  ${rpcNode} -.->|returns| ${nodeId(responseType)}["${shortType(responseType)}"]`,
						);
					}
				}
				out.push("```", "");
			} else {
				out.push("_No RPCs declared._", "");
			}
		}

		if (services.length > detailed.length) {
			out.push(
				`_${services.length - detailed.length} further service(s) omitted._`,
				"",
			);
		}
	}

	/* --- Interdependencies ------------------------------------------ */

	out.push("## Interdependencies", "");

	// Messages used by more than one service are the coupling points: changing
	// one of them changes every surface that returns it.
	const usedBy = new Map<string, Set<string>>();
	for (const [serviceFqn, rpcs] of rpcsByService) {
		for (const rpc of rpcs) {
			const { requestType, responseType } = splitRpcDetail(rpc.detail);
			for (const type of [requestType, responseType]) {
				if (!type || SCALARS.has(type)) {
					continue;
				}
				const bucket = usedBy.get(type);
				if (bucket) {
					bucket.add(serviceFqn);
				} else {
					usedBy.set(type, new Set([serviceFqn]));
				}
			}
		}
	}

	const shared = [...usedBy.entries()]
		.filter(([, owners]) => owners.size > 1)
		.sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]))
		.slice(0, MAX_SHARED);

	if (shared.length > 0) {
		out.push("### Types shared across services", "");
		out.push(
			"Changing one of these changes every service listed beside it.",
			"",
		);
		out.push("| Type | Services |", "| --- | --- |");
		for (const [type, owners] of shared) {
			const names = [...owners].map((fqn) => fqn.split(".").pop()).sort();
			out.push(`| \`${cell(shortType(type))}\` | ${cell(names.join(", "))} |`);
		}
		out.push("");
	} else {
		out.push("_No message type is used by more than one service._", "");
	}

	// Package-level import graph, derived from each file's own imports.
	const pkgEdges = new Map<string, Set<string>>();
	for (const file of files) {
		if (!file.packageName) {
			continue;
		}
		for (const importPath of file.imports) {
			// Well-known imports are noise in a graph of the workspace's shape.
			if (importPath.startsWith("google/")) {
				continue;
			}
			const target = files.find((other) =>
				other.path.endsWith(importPath.split("/").join(path.sep)),
			);
			const targetPkg = target?.packageName;
			if (!targetPkg || targetPkg === file.packageName) {
				continue;
			}
			const bucket = pkgEdges.get(file.packageName);
			if (bucket) {
				bucket.add(targetPkg);
			} else {
				pkgEdges.set(file.packageName, new Set([targetPkg]));
			}
		}
	}

	if (pkgEdges.size > 0) {
		out.push("### Package imports", "");
		out.push("```mermaid", "graph LR");
		for (const [from, targets] of [...pkgEdges].sort()) {
			for (const to of [...targets].sort()) {
				out.push(`  ${nodeId(from)}["${from}"] --> ${nodeId(to)}["${to}"]`);
			}
		}
		out.push("```", "");
	}

	/* --- Resources and messages ------------------------------------- */

	if (messages.length > 0) {
		out.push("## Messages", "");
		const listed = messages.slice(0, MAX_LISTED_MESSAGES);
		out.push("| Message | Package | Summary | Findings |");
		out.push("| --- | --- | --- | ---: |");
		for (const message of listed) {
			const file = index.file(message.fileId);
			const count = problemsOf(message);
			out.push(
				`| \`${cell(message.name)}\` | \`${cell(file?.packageName ?? "")}\` | ${cell(
					firstSentence(message.doc),
				)} | ${count > 0 ? `**${count}**` : "—"} |`,
			);
		}
		out.push("");
		if (messages.length > listed.length) {
			out.push(
				`_${messages.length - listed.length} further message(s) omitted._`,
				"",
			);
		}
	}

	if (enums.length > 0) {
		out.push("## Enums", "");
		out.push("| Enum | Package | Summary |", "| --- | --- | --- |");
		for (const item of enums.slice(0, MAX_LISTED_MESSAGES)) {
			const file = index.file(item.fileId);
			out.push(
				`| \`${cell(item.name)}\` | \`${cell(file?.packageName ?? "")}\` | ${cell(
					firstSentence(item.doc),
				)} |`,
			);
		}
		out.push("");
	}

	/* --- Lint summary ------------------------------------------------ */

	if (totalProblems > 0) {
		const byRule = new Map<string, number>();
		for (const list of findings.values()) {
			for (const finding of list) {
				const code = finding.code;
				const rule =
					code && typeof code === "object" && "value" in code
						? String((code as { value: string | number }).value)
						: String(code ?? "unknown");
				byRule.set(rule, (byRule.get(rule) ?? 0) + 1);
			}
		}
		out.push("## Lint findings by rule", "");
		out.push("| Rule | Count |", "| --- | ---: |");
		for (const [rule, count] of [...byRule].sort((a, b) => b[1] - a[1])) {
			// `core::0191::proto-package` documents at `/191/proto-package`: the
			// rule id zero-pads the AIP number and the site does not, so a
			// straight join produces a 404 on every link in the table.
			const url = `https://linter.aip.dev/${rule
				.split("::")
				.slice(1)
				.map((part) => part.replace(/^0+(?=\d)/, ""))
				.join("/")}`;
			out.push(`| [\`${cell(rule)}\`](${url}) | ${count} |`);
		}
		out.push("");
	}

	return {
		markdown: out.join("\n"),
		stats: {
			services: services.length,
			rpcs: totalRpcs,
			messages: messages.length,
			enums: enums.length,
			files: files.length,
			packages: packages.size,
			problems: totalProblems,
		},
	};
}
