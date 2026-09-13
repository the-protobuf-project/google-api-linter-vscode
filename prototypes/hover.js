"use strict";
const { indexRoots } = require("./annotations.js");
const S = __dirname;

const { annotations, messages } = indexRoots([`${S}/mcpv1`]);

// Which proto element each extendee may legally decorate.
const TARGET_LABEL = {
	File: "file",
	Message: "message",
	Field: "field",
	Oneof: "oneof",
	Enum: "enum",
	EnumValue: "enum value",
	Service: "service",
	Method: "rpc",
};

/** Render the hover card for an annotation — everything derived, nothing hardcoded. */
function hover(a) {
	const L = [];
	L.push(`### \`(${a.fqn})\``);
	L.push(
		`**${TARGET_LABEL[a.target]}** option · \`${a.type}\` · field ${a.number}`,
	);
	L.push("");
	if (a.doc) {
		L.push(a.doc);
		L.push("");
	}

	const body =
		messages.get(`${a.fqn.split(".").slice(0, -1).join(".")}.${a.type}`) ||
		[...messages].find(([k]) => k.endsWith(`.${a.type}`))?.[1];
	if (body?.fields.length) {
		L.push("**Fields**");
		L.push("");
		for (const f of body.fields) {
			const t = f.repeated ? `repeated ${f.type}` : f.type;
			L.push(`- \`${f.name}\` — _${t}_${f.doc ? " · " + f.doc : ""}`);
		}
		L.push("");
	}
	if (a.example) {
		L.push("```proto");
		L.push(a.example);
		L.push("```");
		L.push("");
	}
	L.push(`_Defined in_ \`${a.file}:${a.line}\``);
	return L.join("\n");
}

const want = process.argv[2] || "mcp.v1.tool";
const a = annotations.find((x) => x.fqn === want);
if (!a) {
	console.log(`not found: ${want}`);
	process.exit(1);
}
console.log(hover(a));
console.log("\n" + "═".repeat(70) + "\n");
console.log("ALL DISCOVERED mcp.v1 ANNOTATIONS (valid target in brackets):\n");
for (const x of annotations.sort((p, q) => p.number - q.number))
	console.log(
		`  (${x.fqn})`.padEnd(28) +
			`[${TARGET_LABEL[x.target]}]`.padEnd(14) +
			`${x.type}  #${x.number}`,
	);
