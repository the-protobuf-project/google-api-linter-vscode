/**
 * Tests for the columnar stores the index keeps its hot data in.
 *
 * A symbol is a row index into eleven parallel typed arrays, not an object. At
 * the corpus scale — 76,346 symbols over 9,257 files — that is the difference
 * between about 10 MB of `Int32Array` and well over 100 MB of JS objects, and it
 * is most of what took the extension host from ~60 GB to ~25 MB. Three things
 * have to hold for that to stay true:
 *
 *  1. **A row id is an address.** Every column written by `add` reads back
 *     unchanged, including the `-1` sentinels that mean "no fqn", "no detail",
 *     "no doc" and "unresolved". These are `Int32Array`s precisely so `-1` is
 *     storable; a `Uint32Array` would turn every sentinel into 4,294,967,295.
 *  2. **Freed rows are reused, not leaked.** Editing one file frees its rows and
 *     re-adds them. If `free` did not recycle, `highWater` would climb on every
 *     keystroke and the whole-store scans in `searchSymbols` and `resolveAll`
 *     would get slower forever.
 *  3. **A reused row carries nothing from its predecessor.** This is the store
 *     half of the bug that let a removed file's symbols answer queries under the
 *     next file's id.
 *
 * The columns are public fields, so these tests read them directly; that is the
 * interface `ProtoIndexImpl` uses.
 */

import { describe, expect, test } from "bun:test";
import {
	KIND_ENUM,
	KIND_MESSAGE,
	kindId,
	type ReferenceRow,
	ReferenceStore,
	SYMBOL_KINDS,
	type SymbolRow,
	SymbolStore,
} from "../../../index/store";
import type { SymbolKind } from "../../../index/types";

/** Rows the store starts with before it has to double. */
const INITIAL_CAPACITY = 1024;

/** The `Uint16Array` ceiling the column clamps at. */
const MAX_COL = 0xffff;

/** A symbol row with every column distinguishable from every other. */
function symbolRow(overrides: Partial<SymbolRow> = {}): SymbolRow {
	return {
		nameId: 11,
		kind: kindId("message"),
		fileId: 22,
		line: 33,
		startCol: 44,
		endCol: 55,
		containerId: 66,
		fqnId: 77,
		detailId: 88,
		docId: 99,
		...overrides,
	};
}

/** A reference row with every column distinguishable from every other. */
function referenceRow(overrides: Partial<ReferenceRow> = {}): ReferenceRow {
	return {
		typeId: 11,
		scopeId: 22,
		fileId: 33,
		line: 44,
		startCol: 55,
		endCol: 66,
		...overrides,
	};
}

/** Every symbol column of one row, for whole-row comparisons. */
function readSymbol(store: SymbolStore, i: number): Record<string, number> {
	return {
		name: store.name[i],
		kind: store.kind[i],
		file: store.file[i],
		line: store.line[i],
		startCol: store.startCol[i],
		endCol: store.endCol[i],
		container: store.container[i],
		fqn: store.fqn[i],
		detail: store.detail[i],
		doc: store.doc[i],
		alive: store.alive[i],
	};
}

describe("kind codes", () => {
	test("round-trips every kind through its numeric code", () => {
		// The `kind` column is a `Uint8Array`, so the code is the only thing stored
		// and `SYMBOL_KINDS[code]` is how a query gets the name back.
		for (const kind of SYMBOL_KINDS) {
			expect(SYMBOL_KINDS[kindId(kind)]).toBe(kind);
		}
		expect(SYMBOL_KINDS).toEqual([
			"message",
			"enum",
			"service",
			"rpc",
			"field",
			"enumValue",
			"extend",
		]);
	});

	test("names the two kinds a type reference may resolve to", () => {
		// Resolution refuses anything that is not a message or an enum: a service
		// is a declaration, but no field type can name one.
		expect(KIND_MESSAGE).toBe(kindId("message"));
		expect(KIND_ENUM).toBe(kindId("enum"));
		expect(KIND_MESSAGE).not.toBe(KIND_ENUM);
	});

	test("falls back to message for a kind it does not know", () => {
		// Unreachable from the parser, which only ever passes a `SymbolKind`; the
		// fallback exists so a future kind cannot write `undefined` into the column.
		expect(kindId("nonsense" as SymbolKind)).toBe(0);
	});
});

describe("SymbolStore", () => {
	test("starts empty", () => {
		const store = new SymbolStore();
		expect(store.count).toBe(0);
		expect(store.highWater).toBe(0);
		expect(store.byteSize).toBe(INITIAL_CAPACITY * 33);
	});

	test("hands out consecutive rows and reads every column back", () => {
		const store = new SymbolStore();
		const first = store.add(symbolRow());
		const second = store.add(symbolRow({ nameId: 1000, line: 2000 }));

		expect(first).toBe(0);
		expect(second).toBe(1);
		expect(store.count).toBe(2);
		expect(store.highWater).toBe(2);
		expect(readSymbol(store, first)).toEqual({
			name: 11,
			kind: kindId("message"),
			file: 22,
			line: 33,
			startCol: 44,
			endCol: 55,
			container: 66,
			fqn: 77,
			detail: 88,
			doc: 99,
			alive: 1,
		});
		expect(store.name[second]).toBe(1000);
		expect(store.line[second]).toBe(2000);
	});

	test("stores the -1 sentinels rather than wrapping them", () => {
		// `fqnId`, `detailId` and `docId` are -1 for a symbol with no interned fqn,
		// no detail and no doc comment. Signed columns are the whole reason these
		// are `Int32Array` and not `Uint32Array`.
		const store = new SymbolStore();
		const i = store.add(symbolRow({ fqnId: -1, detailId: -1, docId: -1 }));
		expect(store.fqn[i]).toBe(-1);
		expect(store.detail[i]).toBe(-1);
		expect(store.doc[i]).toBe(-1);
	});

	test("clamps a column beyond the 16-bit ceiling", () => {
		// `startCol` and `endCol` are `Uint16Array`: two bytes each over 300k rows
		// is worth more than exact columns on a line no human wrote. Clamping keeps
		// a pathological generated line from wrapping round to a small number and
		// pointing the editor at the wrong place.
		const store = new SymbolStore();
		const i = store.add(
			symbolRow({ startCol: MAX_COL + 1, endCol: 1_000_000, line: 1_000_000 }),
		);
		expect(store.startCol[i]).toBe(MAX_COL);
		expect(store.endCol[i]).toBe(MAX_COL);
		// `line` is `Int32Array`, so it is not clamped.
		expect(store.line[i]).toBe(1_000_000);
	});

	test("stops counting a freed row but keeps its address", () => {
		const store = new SymbolStore();
		const kept = store.add(symbolRow());
		const dropped = store.add(symbolRow({ nameId: 2 }));

		store.free(dropped);

		expect(store.count).toBe(1);
		// `highWater` is the scan bound, not the live count: the row is still
		// addressable, it is just marked dead.
		expect(store.highWater).toBe(2);
		expect(store.alive[dropped]).toBe(0);
		expect(store.alive[kept]).toBe(1);
		// The doc slot is released eagerly so the doc table can reuse it.
		expect(store.doc[dropped]).toBe(-1);
	});

	test("freeing the same row twice changes nothing", () => {
		// `dropFile` and the tier purge can both reach the same row. A second free
		// must not decrement the count again or queue the row twice, which would
		// hand one address to two different symbols.
		const store = new SymbolStore();
		store.add(symbolRow());
		const dropped = store.add(symbolRow());
		store.free(dropped);
		store.free(dropped);
		expect(store.count).toBe(1);

		const a = store.add(symbolRow({ nameId: 7 }));
		const b = store.add(symbolRow({ nameId: 8 }));
		expect(a).toBe(dropped);
		expect(b).not.toBe(a);
		expect(store.count).toBe(3);
	});

	test("freeing a row nobody allocated changes nothing", () => {
		const store = new SymbolStore();
		store.add(symbolRow());
		store.free(500);
		expect(store.count).toBe(1);
		expect(store.highWater).toBe(1);
		expect(store.add(symbolRow())).toBe(1);
	});

	test("reuses freed rows instead of growing", () => {
		// Re-indexing one file frees its rows and adds the same number back. If the
		// free list did not exist, `highWater` would climb on every save and every
		// whole-store scan would get slower for the rest of the session.
		const store = new SymbolStore();
		const rows = [0, 1, 2, 3].map((n) => store.add(symbolRow({ nameId: n })));
		store.free(rows[1]);
		store.free(rows[2]);
		expect(store.count).toBe(2);

		// Most recently freed first.
		expect(store.add(symbolRow({ nameId: 20 }))).toBe(rows[2]);
		expect(store.add(symbolRow({ nameId: 21 }))).toBe(rows[1]);
		expect(store.count).toBe(4);
		expect(store.highWater).toBe(4);
	});

	test("a reused row carries nothing from its predecessor", () => {
		const store = new SymbolStore();
		const dropped = store.add(
			symbolRow({
				nameId: 1,
				kind: kindId("service"),
				fileId: 2,
				line: 3,
				startCol: 4,
				endCol: 5,
				containerId: 6,
				fqnId: 7,
				detailId: 8,
				docId: 9,
			}),
		);
		store.free(dropped);

		const reused = store.add(
			symbolRow({
				nameId: 91,
				kind: kindId("enumValue"),
				fileId: 92,
				line: 93,
				startCol: 94,
				endCol: 95,
				containerId: 96,
				fqnId: -1,
				detailId: -1,
				docId: -1,
			}),
		);
		expect(reused).toBe(dropped);
		expect(readSymbol(store, reused)).toEqual({
			name: 91,
			kind: kindId("enumValue"),
			file: 92,
			line: 93,
			startCol: 94,
			endCol: 95,
			container: 96,
			fqn: -1,
			detail: -1,
			doc: -1,
			alive: 1,
		});
	});

	test("doubles capacity past the initial block and keeps earlier rows", () => {
		const store = new SymbolStore();
		for (let n = 0; n < INITIAL_CAPACITY; n++) {
			store.add(symbolRow({ nameId: n, line: n }));
		}
		expect(store.byteSize).toBe(INITIAL_CAPACITY * 33);

		const overflow = store.add(symbolRow({ nameId: 12345, line: 54321 }));
		expect(overflow).toBe(INITIAL_CAPACITY);
		expect(store.byteSize).toBe(INITIAL_CAPACITY * 2 * 33);
		expect(store.count).toBe(INITIAL_CAPACITY + 1);
		// Every column has to survive the copy into the wider arrays, not just the
		// one that triggered it.
		expect(store.name[0]).toBe(0);
		expect(store.line[INITIAL_CAPACITY - 1]).toBe(INITIAL_CAPACITY - 1);
		expect(store.alive[INITIAL_CAPACITY - 1]).toBe(1);
		expect(store.name[overflow]).toBe(12345);
	});

	test("clear releases the grown arrays and resets the counters", () => {
		const store = new SymbolStore();
		for (let n = 0; n < INITIAL_CAPACITY + 10; n++) {
			store.add(symbolRow({ nameId: n }));
		}
		store.free(5);
		store.clear();

		expect(store.count).toBe(0);
		expect(store.highWater).toBe(0);
		// Back to one block: a rebuild must not keep the previous workspace's
		// columns alive.
		expect(store.byteSize).toBe(INITIAL_CAPACITY * 33);
		expect(store.name).toHaveLength(INITIAL_CAPACITY);
		expect(store.alive[0]).toBe(0);
		// The free list went with it, so the next row is row 0 again.
		expect(store.add(symbolRow({ nameId: 1 }))).toBe(0);
	});

	test("holds a corpus-sized population in a bounded set of arrays", () => {
		// 300k rows is about four times the reference corpus. The claim being
		// pinned is the one the rewrite rests on: the cost is the columns, and the
		// columns are a few tens of bytes per symbol however many there are.
		const store = new SymbolStore();
		const count = 300_000;
		for (let n = 0; n < count; n++) {
			store.add(symbolRow({ nameId: n, fileId: n % 9000, line: n % 4000 }));
		}
		expect(store.count).toBe(count);
		expect(store.highWater).toBe(count);
		// Capacity doubles, so the arrays are at most twice the rows in use.
		expect(store.byteSize).toBeLessThan(count * 33 * 2);
		expect(store.name[count - 1]).toBe(count - 1);
		expect(store.file[count - 1]).toBe((count - 1) % 9000);
	});
});

describe("ReferenceStore", () => {
	test("starts empty", () => {
		const store = new ReferenceStore();
		expect(store.count).toBe(0);
		expect(store.highWater).toBe(0);
		expect(store.byteSize).toBe(INITIAL_CAPACITY * 25);
	});

	test("hands out consecutive rows and reads every column back", () => {
		const store = new ReferenceStore();
		const first = store.add(referenceRow());
		const second = store.add(referenceRow({ typeId: 1000 }));

		expect(first).toBe(0);
		expect(second).toBe(1);
		expect(store.count).toBe(2);
		expect(store.type[first]).toBe(11);
		expect(store.scope[first]).toBe(22);
		expect(store.file[first]).toBe(33);
		expect(store.line[first]).toBe(44);
		expect(store.startCol[first]).toBe(55);
		expect(store.endCol[first]).toBe(66);
		expect(store.alive[first]).toBe(1);
	});

	test("adds a reference unresolved and lets resolution fill it in later", () => {
		// References are stored during the walk and resolved in a second pass, once
		// every declaration is known, so `add` cannot know the answer yet.
		const store = new ReferenceStore();
		const i = store.add(referenceRow());
		expect(store.resolved[i]).toBe(-1);

		store.resolved[i] = 4242;
		expect(store.resolved[i]).toBe(4242);
	});

	test("clamps a column beyond the 16-bit ceiling", () => {
		const store = new ReferenceStore();
		const i = store.add(referenceRow({ startCol: 70_000, endCol: 70_010 }));
		expect(store.startCol[i]).toBe(MAX_COL);
		expect(store.endCol[i]).toBe(MAX_COL);
	});

	test("clears the resolution when a row is freed", () => {
		// `referencesTo` walks buckets that may still list a dead row, and decides
		// by `alive === 1 && resolved === fqnId`. A freed row keeping its old
		// resolution would report a reference into a file that no longer exists.
		const store = new ReferenceStore();
		const i = store.add(referenceRow());
		store.resolved[i] = 4242;
		store.free(i);
		expect(store.alive[i]).toBe(0);
		expect(store.resolved[i]).toBe(-1);
		expect(store.count).toBe(0);
	});

	test("freeing the same row twice changes nothing", () => {
		const store = new ReferenceStore();
		store.add(referenceRow());
		const dropped = store.add(referenceRow());
		store.free(dropped);
		store.free(dropped);
		expect(store.count).toBe(1);
		expect(store.add(referenceRow())).toBe(dropped);
		expect(store.add(referenceRow())).toBe(2);
	});

	test("a reused row is unresolved again and keeps nothing from before", () => {
		const store = new ReferenceStore();
		const dropped = store.add(referenceRow({ typeId: 1, scopeId: 2, line: 3 }));
		store.resolved[dropped] = 999;
		store.free(dropped);

		const reused = store.add(
			referenceRow({ typeId: 81, scopeId: 82, fileId: 83, line: 84 }),
		);
		expect(reused).toBe(dropped);
		expect(store.type[reused]).toBe(81);
		expect(store.scope[reused]).toBe(82);
		expect(store.file[reused]).toBe(83);
		expect(store.line[reused]).toBe(84);
		expect(store.resolved[reused]).toBe(-1);
		expect(store.alive[reused]).toBe(1);
	});

	test("doubles capacity past the initial block and keeps earlier rows", () => {
		const store = new ReferenceStore();
		for (let n = 0; n < INITIAL_CAPACITY; n++) {
			store.add(referenceRow({ typeId: n }));
		}
		store.resolved[7] = 700;
		expect(store.byteSize).toBe(INITIAL_CAPACITY * 25);

		const overflow = store.add(referenceRow({ typeId: 12345 }));
		expect(overflow).toBe(INITIAL_CAPACITY);
		expect(store.byteSize).toBe(INITIAL_CAPACITY * 2 * 25);
		expect(store.type[0]).toBe(0);
		expect(store.resolved[7]).toBe(700);
		expect(store.type[overflow]).toBe(12345);
	});

	test("clear releases the grown arrays and resets the counters", () => {
		const store = new ReferenceStore();
		for (let n = 0; n < INITIAL_CAPACITY + 10; n++) {
			store.add(referenceRow({ typeId: n }));
		}
		store.clear();
		expect(store.count).toBe(0);
		expect(store.highWater).toBe(0);
		expect(store.byteSize).toBe(INITIAL_CAPACITY * 25);
		expect(store.type).toHaveLength(INITIAL_CAPACITY);
		expect(store.add(referenceRow())).toBe(0);
	});
});
