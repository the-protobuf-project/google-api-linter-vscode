/**
 * Tests for string flattening and interning.
 *
 * This is the smallest module in the index and the one the memory figure rests
 * on. The parser reads 26 MB of proto text and the index keeps a few megabytes
 * of names out of it; both halves of that have to hold.
 *
 *  - **Flattening.** A regex capture group is a V8 `SlicedString`: a header
 *    pointing at the whole parent. Keeping the 13-character name `SubjectChoice`
 *    out of a 300 KB file keeps all 300 KB alive. `flattenString` forces a copy
 *    above V8's `SlicedString::kMinLength` and returns the input unchanged below
 *    it, where V8 already copied. Retention itself is a V8 property and not
 *    observable from a test — these tests pin the boundary and the contract that
 *    contents survive the copy byte for byte, unicode included.
 *  - **Interning.** Ids are the whole storage format: the columnar stores hold
 *    `Int32Array`s of pool ids, so an id that shifts, or a `get` that answers
 *    for an id it never handed out, mis-addresses every symbol at once. Ids are
 *    stable for the pool's life, nothing is ever evicted, and `clear` invalidates
 *    every id including the lower-case cache behind them.
 */

import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { flattenString, StringPool } from "../../../index/strings";
import {
	hasReferenceCorpus,
	listProtos,
	REFERENCE_PROTO_ROOT,
} from "../support/fixtures";

/** V8's `SlicedString::kMinLength`, the threshold the function switches on. */
const SLICE_MIN_LENGTH = 13;

/** A string long enough that V8 would have sliced rather than copied it. */
const LONG = "SubjectChoice";

describe("flattenString", () => {
	test("returns a short string unchanged", () => {
		// Below the threshold V8 never built a slice, so there is nothing to undo
		// and the function must not pay for a copy on the common case.
		const short = "Patient";
		expect(flattenString(short)).toBe(short);
		expect(short.length).toBeLessThan(SLICE_MIN_LENGTH);
	});

	test("returns the empty string unchanged", () => {
		expect(flattenString("")).toBe("");
	});

	test("copies at and above the threshold, contents identical", () => {
		expect(LONG).toHaveLength(SLICE_MIN_LENGTH);
		expect(flattenString(LONG)).toBe(LONG);

		const below = LONG.slice(0, SLICE_MIN_LENGTH - 1);
		expect(flattenString(below)).toBe(below);
	});

	test("survives a slice taken out of a large parent", () => {
		// The shape the parser actually produces: a capture group out of a file's
		// worth of text. Whatever V8 does underneath, the characters come back.
		const parent = `${"x".repeat(300_000)}message SubjectChoice {`;
		const name = parent.slice(300_008, 300_021);
		expect(name).toBe("SubjectChoice");
		expect(flattenString(name)).toBe("SubjectChoice");
	});

	test("preserves unicode, including characters outside the BMP", () => {
		// The threshold is a UTF-16 code-unit count, so an astral character counts
		// as two. What matters is that the copy does not split a surrogate pair.
		const astral = "Ident_\u{1F600}\u{1F600}_ifier";
		expect(flattenString(astral)).toBe(astral);
		expect([...flattenString(astral)]).toEqual([...astral]);

		const accented = "Identificación_médica";
		expect(flattenString(accented)).toBe(accented);

		// A combining mark must not be separated from the character it modifies.
		const combining = "Café_identifier";
		expect(flattenString(combining)).toBe(combining);
		expect(flattenString(combining).normalize("NFC")).toBe(
			combining.normalize("NFC"),
		);
	});

	test("preserves leading and trailing whitespace", () => {
		// The implementation prepends a space and slices it back off, so a string
		// that already begins with one is the case that would give it away.
		expect(flattenString("  leading whitespace")).toBe("  leading whitespace");
		expect(flattenString("trailing whitespace  ")).toBe(
			"trailing whitespace  ",
		);
		expect(flattenString(" \t\n a value that is long")).toBe(
			" \t\n a value that is long",
		);
	});

	test("preserves a string that is only whitespace", () => {
		const blanks = " ".repeat(20);
		expect(flattenString(blanks)).toBe(blanks);
		expect(flattenString(blanks)).toHaveLength(20);
	});
});

describe("StringPool", () => {
	test("starts empty", () => {
		const pool = new StringPool();
		expect(pool.size).toBe(0);
		expect(pool.lookup("anything")).toBeUndefined();
	});

	test("hands out consecutive ids and reads them back", () => {
		const pool = new StringPool();
		expect(pool.intern("demo.v1")).toBe(0);
		expect(pool.intern("Patient")).toBe(1);
		expect(pool.intern("Address")).toBe(2);
		expect(pool.size).toBe(3);
		expect(pool.get(0)).toBe("demo.v1");
		expect(pool.get(1)).toBe("Patient");
		expect(pool.get(2)).toBe("Address");
	});

	test("gives one id to every occurrence of a string", () => {
		// `SubjectChoice` appears in 87 files in the reference corpus. One entry,
		// 87 `Int32Array` slots pointing at it, is the saving this class exists for.
		const pool = new StringPool();
		const first = pool.intern("SubjectChoice");
		for (let n = 0; n < 100; n++) {
			expect(pool.intern("SubjectChoice")).toBe(first);
		}
		expect(pool.size).toBe(1);
	});

	test("dedupes a long string against a slice with the same contents", () => {
		// The intern path flattens before storing, so the stored key is a copy;
		// a later lookup by an equal-but-differently-represented string still has
		// to land on the same id, or every re-parse would grow the pool.
		const pool = new StringPool();
		const direct = pool.intern(
			"protobuf.fhir.base.entities.v5.types.Attachment",
		);
		const parent = `message protobuf.fhir.base.entities.v5.types.Attachment {`;
		const sliced = parent.slice(8, 55);
		expect(sliced).toBe("protobuf.fhir.base.entities.v5.types.Attachment");
		expect(pool.intern(sliced)).toBe(direct);
		expect(pool.lookup(sliced)).toBe(direct);
		expect(pool.size).toBe(1);
	});

	test("keeps ids stable as the pool grows", () => {
		const pool = new StringPool();
		const ids = new Map<string, number>();
		for (let n = 0; n < 5000; n++) {
			ids.set(`name_${n}`, pool.intern(`name_${n}`));
		}
		expect(pool.size).toBe(5000);
		const drifted = [...ids].filter(
			([value, id]) => pool.get(id) !== value || pool.intern(value) !== id,
		);
		expect(drifted).toEqual([]);
	});

	test("holds the empty string like any other", () => {
		// Files with no `package` statement intern `""` as their package name, so
		// this is a live case rather than a curiosity.
		const pool = new StringPool();
		expect(pool.intern("Patient")).toBe(0);
		const empty = pool.intern("");
		expect(empty).toBe(1);
		expect(pool.get(empty)).toBe("");
		expect(pool.lookup("")).toBe(1);
		expect(pool.size).toBe(2);
	});

	test("answers an id it never handed out with the empty string", () => {
		// The columns use -1 as "no value", and `toSymbol` reads `get(-1)`
		// routinely. It has to be empty rather than `undefined`, which would leak
		// into a symbol's `fqn` as the text "undefined".
		const pool = new StringPool();
		pool.intern("Patient");
		expect(pool.get(-1)).toBe("");
		expect(pool.get(1)).toBe("");
		expect(pool.get(1_000_000)).toBe("");
		expect(pool.get(Number.NaN)).toBe("");
	});

	test("looks up without interning", () => {
		const pool = new StringPool();
		pool.intern("Patient");
		expect(pool.lookup("Patient")).toBe(0);
		expect(pool.lookup("Absent")).toBeUndefined();
		// A failed lookup must not have added anything: `symbol()` calls this for
		// every fqn a user types, most of which name nothing.
		expect(pool.size).toBe(1);
	});

	test("interns unicode names distinctly", () => {
		const pool = new StringPool();
		const plain = pool.intern("Identificacion");
		const accented = pool.intern("Identificación");
		const composed = pool.intern("Identificación");
		expect(accented).not.toBe(plain);
		// NFC and NFD spellings are different strings and stay different ids; the
		// pool compares code units, it does not normalise.
		expect(composed).not.toBe(accented);
		expect(pool.get(accented)).toBe("Identificación");
		expect(pool.get(composed)).toBe("Identificación");
		expect(pool.size).toBe(3);
	});

	test("lowercases on demand and caches the result", () => {
		const pool = new StringPool();
		const id = pool.intern("PatientRecord");
		expect(pool.lower(id)).toBe("patientrecord");
		// Cached: the second call has to give the identical string back, which is
		// what keeps `searchSymbols` from re-lowering every name on every keystroke.
		expect(pool.lower(id)).toBe(pool.lower(id));
		// The interned value is untouched.
		expect(pool.get(id)).toBe("PatientRecord");
	});

	test("reuses the original when it is already lower-case", () => {
		// The common case in a proto is a snake_case field name, already lower.
		// Storing a second copy of every one of those would undo the interning.
		const pool = new StringPool();
		const id = pool.intern("subject_choice_reference");
		expect(pool.lower(id)).toBe(pool.get(id));
	});

	test("lowercases unicode by the same rules as the language", () => {
		const pool = new StringPool();
		const accented = pool.intern("IdentificaciÓN");
		expect(pool.lower(accented)).toBe("identificación");
		// Locale-independent: `toLowerCase` is not `toLocaleLowerCase`, so a
		// Turkish locale cannot change what a search matches.
		const dotted = pool.intern("İSTANBUL");
		expect(pool.lower(dotted)).toBe("İSTANBUL".toLowerCase());
		// Characters with no lower-case form come back unchanged.
		const digits = pool.intern("STATUS_ACTIVE_1");
		expect(pool.lower(digits)).toBe("status_active_1");
	});

	test("lowers an id it never handed out to the empty string", () => {
		const pool = new StringPool();
		pool.intern("Patient");
		expect(pool.lower(999)).toBe("");
		expect(pool.lower(-1)).toBe("");
		expect(pool.size).toBe(1);
	});

	test("evicts nothing, so a name keeps its id for the pool's life", () => {
		// There is no removal API by design: a name that disappears from a file
		// usually reappears on the next keystroke, and the pool is bounded by the
		// distinct identifiers in the workspace rather than by edits.
		const pool = new StringPool();
		const kept = pool.intern("Patient");
		for (let n = 0; n < 2000; n++) {
			pool.intern(`transient_${n}`);
		}
		expect(pool.get(kept)).toBe("Patient");
		expect(pool.lookup("Patient")).toBe(kept);
		expect(pool.size).toBe(2001);
	});

	test("clear invalidates every id, the lower-case cache included", () => {
		const pool = new StringPool();
		const id = pool.intern("Alpha");
		expect(pool.lower(id)).toBe("alpha");

		pool.clear();
		expect(pool.size).toBe(0);
		expect(pool.get(id)).toBe("");
		expect(pool.lookup("Alpha")).toBeUndefined();

		// Ids start again at 0, so a stale lower-case entry would answer for the
		// wrong string — the rebuild-after-rebuild case.
		const reused = pool.intern("Beta");
		expect(reused).toBe(id);
		expect(pool.get(reused)).toBe("Beta");
		expect(pool.lower(reused)).toBe("beta");
	});

	test("clears an empty pool without complaint", () => {
		const pool = new StringPool();
		pool.clear();
		pool.clear();
		expect(pool.size).toBe(0);
		expect(pool.intern("Patient")).toBe(0);
	});
});

describe.skipIf(!hasReferenceCorpus())("against the real corpus", () => {
	test("collapses the corpus's repeated names to a fraction of the pool", () => {
		// Real proof of the saving: the reference tree's 9,257 paths are made of
		// tens of thousands of segments drawn from a much smaller vocabulary —
		// `types`, `v5`, `v6`, `resource.proto`, `attachment.proto` — which is the
		// same shape the type names have.
		const files = listProtos(REFERENCE_PROTO_ROOT as string);
		expect(files.length).toBeGreaterThan(9000);

		const pool = new StringPool();
		const ids: number[] = [];
		let interned = 0;
		for (const file of files) {
			for (const segment of path
				.relative(REFERENCE_PROTO_ROOT as string, file)
				.split(path.sep)) {
				ids.push(pool.intern(segment));
				interned++;
			}
		}

		expect(interned).toBeGreaterThan(40_000);
		// An order of magnitude fewer distinct strings than occurrences.
		expect(pool.size).toBeLessThan(interned / 10);
		// Every id still addresses the string it was handed out for.
		const distinct = [...new Set(ids)];
		expect(distinct).toHaveLength(pool.size);
		expect(
			distinct.filter(
				(id) => pool.get(id).length === 0 || pool.lookup(pool.get(id)) !== id,
			),
		).toEqual([]);
	});
});
