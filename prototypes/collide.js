const {
	indexRoots,
} = require("/private/tmp/claude-501/-Users-srikanthkandarp-Projects-personal-protobuf-fhir/5e363a36-3249-4340-b26d-c7dcacdddd2c/scratchpad/annotations.js");
const fs = require("node:fs"),
	path = require("node:path");
const B = path.join(process.env.HOME, ".cache/buf/v3/modules/b5/buf.build");
const roots = [];
for (const org of fs.readdirSync(B))
	for (const m of fs.readdirSync(path.join(B, org)))
		for (const c of fs.readdirSync(path.join(B, org, m)))
			roots.push(path.join(B, org, m, c, "files"));

const { annotations } = indexRoots(roots);
// Protobuf requires extension field numbers to be unique per extendee across the
// whole descriptor pool. Two modules extending the same Options with the same
// number cannot be imported into one file.
const byKey = new Map();
for (const a of annotations) {
	const k = `${a.target}Options#${a.number}`;
	if (!byKey.has(k)) byKey.set(k, new Map());
	byKey.get(k).set(a.fqn, a); // dedupe identical fqn across cached commits
}
const clashes = [...byKey].filter(([, m]) => m.size > 1);
console.log(`extension slots in use: ${byKey.size}`);
console.log(`slots claimed by >1 distinct extension: ${clashes.length}\n`);
for (const [k, m] of clashes) {
	console.log(`  ${k}`);
	for (const [fqn, a] of m) console.log(`      (${fqn})  ${a.file}:${a.line}`);
}
// Also: per-namespace number ranges, which the modules document in prose.
const ranges = new Map();
for (const a of annotations) {
	const ns = a.fqn.split(".").slice(0, -1).join(".");
	const r = ranges.get(ns) ?? [Infinity, -Infinity];
	ranges.set(ns, [Math.min(r[0], a.number), Math.max(r[1], a.number)]);
}
console.log("\nnamespace ranges actually observed:");
for (const [ns, [lo, hi]] of [...ranges].sort((a, b) => a[1][0] - b[1][0]))
	console.log(`  ${ns.padEnd(22)} ${lo}–${hi}`);
