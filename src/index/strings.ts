/**
 * String flattening and interning for the proto index.
 *
 * ## The sliced-string hazard
 *
 * V8 represents the result of `String.prototype.slice`, `substring`, `split`
 * and every regex capture group as a `SlicedString`: a 3-word header holding an
 * offset, a length and a **pointer to the entire parent string**. Extracting the
 * name `SubjectChoice` out of a 300 KB `.proto` therefore keeps all 300 KB
 * alive for as long as that 13-character name is referenced.
 *
 * The index parses 25 MB of proto text and retains a few megabytes of names. If
 * every retained name were a slice, the index would silently retain the whole
 * 25 MB of source instead — exactly the retention this rewrite exists to delete.
 *
 * {@link flattenString} forces a private copy:
 *
 * - Below `SlicedString::kMinLength` (13) V8 never builds a slice at all; it
 *   copies into a fresh sequential string, so the input is already safe.
 * - At or above it, `" " + s` builds a `ConsString`, and slicing a `ConsString`
 *   makes V8 flatten it first. The resulting slice points at that freshly
 *   flattened `|s| + 1` character string — never at the file it came from.
 *
 * Everything the parser hands back has already been through this function, so
 * callers may store parser output directly.
 */

/**
 * V8's `SlicedString::kMinLength`. Substrings shorter than this are copied into
 * a new sequential string rather than sliced, so they retain nothing.
 */
const SLICE_MIN_LENGTH = 13;

/**
 * Returns a string with the same contents that cannot retain a large parent.
 *
 * @param value - A possibly-sliced string, e.g. a regex capture group
 * @returns A string retaining at most `value.length + 1` characters
 */
export function flattenString(value: string): string {
	if (value.length < SLICE_MIN_LENGTH) {
		return value;
	}
	return ` ${value}`.slice(1);
}

/**
 * Deduplicating table of flattened strings, addressed by small integer ids.
 *
 * Hot storage in the index is columnar `Int32Array`s of pool ids; the strings
 * themselves exist once each. On this corpus 1,943 of 2,549 distinct type names
 * occur in more than one file (`SubjectChoice` in 87), so interning is where the
 * bulk of the savings come from.
 *
 * Ids are stable for the lifetime of the pool. Nothing is ever removed: a name
 * that disappears from a file usually reappears in the next edit, and the pool
 * is bounded by the number of distinct identifiers in the workspace.
 */
export class StringPool {
	private readonly ids = new Map<string, number>();
	private readonly values: string[] = [];
	private lowered: (string | undefined)[] = [];

	/** Number of distinct strings held. */
	get size(): number {
		return this.values.length;
	}

	/**
	 * Interns a string, flattening it first so it cannot retain a parent.
	 * @param value - String to intern; may be a slice of a large parent
	 * @returns Stable id for the flattened, deduplicated string
	 */
	intern(value: string): number {
		const existing = this.ids.get(value);
		if (existing !== undefined) {
			return existing;
		}
		const flat = flattenString(value);
		const id = this.values.length;
		this.values.push(flat);
		this.ids.set(flat, id);
		return id;
	}

	/**
	 * Looks a string up without adding it.
	 * @param value - String to look for
	 * @returns Its id, or `undefined` when the pool does not hold it
	 */
	lookup(value: string): number | undefined {
		return this.ids.get(value);
	}

	/**
	 * @param id - Id previously returned by {@link intern}
	 * @returns The interned string, or `""` when the id is out of range
	 */
	get(id: number): string {
		return id >= 0 && id < this.values.length ? this.values[id] : "";
	}

	/**
	 * Lower-cased form of an interned string, computed once per distinct string
	 * and only for strings a search actually touches.
	 * @param id - Id previously returned by {@link intern}
	 * @returns The lower-cased string
	 */
	lower(id: number): string {
		const cached = this.lowered[id];
		if (cached !== undefined) {
			return cached;
		}
		const value = this.get(id);
		const lower = value.toLowerCase();
		// Reuse the original when it is already lower-case, so the common case
		// costs no extra memory.
		const stored = lower === value ? value : lower;
		this.lowered[id] = stored;
		return stored;
	}

	/** Drops every string. Ids handed out before this are no longer valid. */
	clear(): void {
		this.ids.clear();
		this.values.length = 0;
		this.lowered = [];
	}
}
