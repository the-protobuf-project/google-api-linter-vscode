/**
 * Columnar storage for symbols and type references.
 *
 * Nothing here holds an object per symbol. A symbol is a row index into a set
 * of parallel typed arrays, and its strings are {@link StringPool} ids; an
 * {@link IndexedSymbol} object is materialised only when a query returns it.
 * At roughly 300k symbols that is the difference between ~10 MB of typed arrays
 * and well over 100 MB of JS objects.
 *
 * Rows freed by {@link SymbolStore.free} go on a free list and are handed back
 * out by the next insert, so incremental re-index of a single file does not
 * grow the arrays.
 */

import type { SymbolKind } from "./types";

/** Row order of {@link SymbolKind}, stored as a `Uint8Array` column. */
export const SYMBOL_KINDS: readonly SymbolKind[] = [
	"message",
	"enum",
	"service",
	"rpc",
	"field",
	"enumValue",
	"extend",
];

const KIND_IDS = new Map<SymbolKind, number>(
	SYMBOL_KINDS.map((kind, i) => [kind, i]),
);

/** Numeric code for a kind, for the `kind` column. */
export function kindId(kind: SymbolKind): number {
	return KIND_IDS.get(kind) ?? 0;
}

/** Kinds that can contain other declarations and can be referenced by name. */
export const KIND_MESSAGE = kindId("message");
export const KIND_ENUM = kindId("enum");

const INITIAL_CAPACITY = 1024;
/** Columns clamp at this value; no real proto line is this wide. */
const MAX_COL = 0xffff;

function growInt32(source: Int32Array, capacity: number): Int32Array {
	const next = new Int32Array(capacity);
	next.set(source);
	return next;
}

function growUint16(source: Uint16Array, capacity: number): Uint16Array {
	const next = new Uint16Array(capacity);
	next.set(source);
	return next;
}

function growUint8(source: Uint8Array, capacity: number): Uint8Array {
	const next = new Uint8Array(capacity);
	next.set(source);
	return next;
}

/** Row fields for one declaration. All strings are pool ids. */
export interface SymbolRow {
	readonly nameId: number;
	readonly kind: number;
	readonly fileId: number;
	readonly line: number;
	readonly startCol: number;
	readonly endCol: number;
	/** Pool id of the enclosing container's fqn; the package for top-level. */
	readonly containerId: number;
	/** Pool id of the symbol's own fqn, or -1 when it is not interned. */
	readonly fqnId: number;
	/** Pool id of `detail`, or -1. */
	readonly detailId: number;
	/** Index into the doc table, or -1. */
	readonly docId: number;
}

/** Parallel typed-array columns for declarations. */
export class SymbolStore {
	name: Int32Array = new Int32Array(INITIAL_CAPACITY);
	kind: Uint8Array = new Uint8Array(INITIAL_CAPACITY);
	file: Int32Array = new Int32Array(INITIAL_CAPACITY);
	line: Int32Array = new Int32Array(INITIAL_CAPACITY);
	startCol: Uint16Array = new Uint16Array(INITIAL_CAPACITY);
	endCol: Uint16Array = new Uint16Array(INITIAL_CAPACITY);
	container: Int32Array = new Int32Array(INITIAL_CAPACITY);
	fqn: Int32Array = new Int32Array(INITIAL_CAPACITY);
	detail: Int32Array = new Int32Array(INITIAL_CAPACITY);
	doc: Int32Array = new Int32Array(INITIAL_CAPACITY);
	alive: Uint8Array = new Uint8Array(INITIAL_CAPACITY);

	private capacity = INITIAL_CAPACITY;
	private length = 0;
	private readonly freeList: number[] = [];
	private liveCount = 0;

	/** Number of rows in use. */
	get count(): number {
		return this.liveCount;
	}

	/** Highest row index ever allocated, for whole-store scans. */
	get highWater(): number {
		return this.length;
	}

	/**
	 * Appends a row, reusing a freed slot when one is available.
	 * @param row - Column values for the new symbol
	 * @returns The row index
	 */
	add(row: SymbolRow): number {
		const reused = this.freeList.pop();
		const i = reused ?? this.length;
		if (reused === undefined) {
			if (this.length === this.capacity) {
				this.grow();
			}
			this.length++;
		}
		this.name[i] = row.nameId;
		this.kind[i] = row.kind;
		this.file[i] = row.fileId;
		this.line[i] = row.line;
		this.startCol[i] = Math.min(row.startCol, MAX_COL);
		this.endCol[i] = Math.min(row.endCol, MAX_COL);
		this.container[i] = row.containerId;
		this.fqn[i] = row.fqnId;
		this.detail[i] = row.detailId;
		this.doc[i] = row.docId;
		this.alive[i] = 1;
		this.liveCount++;
		return i;
	}

	/**
	 * Releases a row for reuse.
	 * @param i - Row index
	 */
	free(i: number): void {
		if (this.alive[i] === 0) {
			return;
		}
		this.alive[i] = 0;
		this.doc[i] = -1;
		this.freeList.push(i);
		this.liveCount--;
	}

	/** Drops every row. */
	clear(): void {
		this.capacity = INITIAL_CAPACITY;
		this.length = 0;
		this.liveCount = 0;
		this.freeList.length = 0;
		this.name = new Int32Array(INITIAL_CAPACITY);
		this.kind = new Uint8Array(INITIAL_CAPACITY);
		this.file = new Int32Array(INITIAL_CAPACITY);
		this.line = new Int32Array(INITIAL_CAPACITY);
		this.startCol = new Uint16Array(INITIAL_CAPACITY);
		this.endCol = new Uint16Array(INITIAL_CAPACITY);
		this.container = new Int32Array(INITIAL_CAPACITY);
		this.fqn = new Int32Array(INITIAL_CAPACITY);
		this.detail = new Int32Array(INITIAL_CAPACITY);
		this.doc = new Int32Array(INITIAL_CAPACITY);
		this.alive = new Uint8Array(INITIAL_CAPACITY);
	}

	/** Approximate bytes held by the columns. */
	get byteSize(): number {
		return this.capacity * 33;
	}

	private grow(): void {
		const capacity = this.capacity * 2;
		this.name = growInt32(this.name, capacity);
		this.kind = growUint8(this.kind, capacity);
		this.file = growInt32(this.file, capacity);
		this.line = growInt32(this.line, capacity);
		this.startCol = growUint16(this.startCol, capacity);
		this.endCol = growUint16(this.endCol, capacity);
		this.container = growInt32(this.container, capacity);
		this.fqn = growInt32(this.fqn, capacity);
		this.detail = growInt32(this.detail, capacity);
		this.doc = growInt32(this.doc, capacity);
		this.alive = growUint8(this.alive, capacity);
		this.capacity = capacity;
	}
}

/** Row fields for one type reference. */
export interface ReferenceRow {
	/** Pool id of the type name exactly as written. */
	readonly typeId: number;
	/** Pool id of the enclosing container's fqn, used to resolve the name. */
	readonly scopeId: number;
	readonly fileId: number;
	readonly line: number;
	readonly startCol: number;
	readonly endCol: number;
}

/** Parallel typed-array columns for type references. */
export class ReferenceStore {
	type: Int32Array = new Int32Array(INITIAL_CAPACITY);
	scope: Int32Array = new Int32Array(INITIAL_CAPACITY);
	file: Int32Array = new Int32Array(INITIAL_CAPACITY);
	line: Int32Array = new Int32Array(INITIAL_CAPACITY);
	startCol: Uint16Array = new Uint16Array(INITIAL_CAPACITY);
	endCol: Uint16Array = new Uint16Array(INITIAL_CAPACITY);
	/** Pool id of the resolved fqn, or -1 when resolution failed or was ambiguous. */
	resolved: Int32Array = new Int32Array(INITIAL_CAPACITY);
	alive: Uint8Array = new Uint8Array(INITIAL_CAPACITY);

	private capacity = INITIAL_CAPACITY;
	private length = 0;
	private readonly freeList: number[] = [];
	private liveCount = 0;

	/** Number of rows in use. */
	get count(): number {
		return this.liveCount;
	}

	/** Highest row index ever allocated, for whole-store scans. */
	get highWater(): number {
		return this.length;
	}

	/**
	 * Appends a row, reusing a freed slot when one is available.
	 * @param row - Column values for the new reference
	 * @returns The row index
	 */
	add(row: ReferenceRow): number {
		const reused = this.freeList.pop();
		const i = reused ?? this.length;
		if (reused === undefined) {
			if (this.length === this.capacity) {
				this.grow();
			}
			this.length++;
		}
		this.type[i] = row.typeId;
		this.scope[i] = row.scopeId;
		this.file[i] = row.fileId;
		this.line[i] = row.line;
		this.startCol[i] = Math.min(row.startCol, MAX_COL);
		this.endCol[i] = Math.min(row.endCol, MAX_COL);
		this.resolved[i] = -1;
		this.alive[i] = 1;
		this.liveCount++;
		return i;
	}

	/**
	 * Releases a row for reuse.
	 * @param i - Row index
	 */
	free(i: number): void {
		if (this.alive[i] === 0) {
			return;
		}
		this.alive[i] = 0;
		this.resolved[i] = -1;
		this.freeList.push(i);
		this.liveCount--;
	}

	/** Drops every row. */
	clear(): void {
		this.capacity = INITIAL_CAPACITY;
		this.length = 0;
		this.liveCount = 0;
		this.freeList.length = 0;
		this.type = new Int32Array(INITIAL_CAPACITY);
		this.scope = new Int32Array(INITIAL_CAPACITY);
		this.file = new Int32Array(INITIAL_CAPACITY);
		this.line = new Int32Array(INITIAL_CAPACITY);
		this.startCol = new Uint16Array(INITIAL_CAPACITY);
		this.endCol = new Uint16Array(INITIAL_CAPACITY);
		this.resolved = new Int32Array(INITIAL_CAPACITY);
		this.alive = new Uint8Array(INITIAL_CAPACITY);
	}

	/** Approximate bytes held by the columns. */
	get byteSize(): number {
		return this.capacity * 25;
	}

	private grow(): void {
		const capacity = this.capacity * 2;
		this.type = growInt32(this.type, capacity);
		this.scope = growInt32(this.scope, capacity);
		this.file = growInt32(this.file, capacity);
		this.line = growInt32(this.line, capacity);
		this.startCol = growUint16(this.startCol, capacity);
		this.endCol = growUint16(this.endCol, capacity);
		this.resolved = growInt32(this.resolved, capacity);
		this.alive = growUint8(this.alive, capacity);
		this.capacity = capacity;
	}
}
