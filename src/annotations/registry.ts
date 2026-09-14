/**
 * The annotation registry: every custom option the workspace and its buf
 * dependencies declare, derived entirely from `extend google.protobuf.*Options`
 * blocks.
 *
 * Two properties matter here.
 *
 * **Lazy bodies.** The walk stores the option's *type name* only. Resolving that
 * name to a message and walking its fields happens the first time a hover or a
 * completion asks, and is cached from then on. Eagerly resolving 495 option-body
 * messages during the index build would spend memory on shapes nobody looks at.
 *
 * **Collisions.** Protobuf requires extension field numbers to be unique per
 * extendee across the whole descriptor pool, so two annotations claiming the
 * same slot cannot be imported into one file. This registry reports the claims;
 * deciding whether a *given file* actually trips over one is the diagnostics'
 * job, because most overlaps are benign migrations.
 *
 * This module must never import `vscode`.
 */

import type {
	AnnotationBody,
	AnnotationDescriptor,
	AnnotationField,
	AnnotationRegistry,
	AnnotationTarget,
} from "../index/types";
import type {
	ExtractedEnum,
	ExtractedFile,
	ExtractedMessage,
	RawEnumValue,
	RawField,
} from "./extractor";

/** Scalar proto types, which never resolve to a body message. */
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

/** One extension slot claimed by more than one annotation. */
export interface AnnotationCollision {
	readonly target: AnnotationTarget;
	readonly number: number;
	readonly claimants: readonly AnnotationDescriptor[];
}

/** Where an annotation or body message was declared. */
export interface AnnotationOrigin {
	/** Absolute path on disk, when known. */
	readonly path?: string;
	/** Import path other files use, e.g. `mcp/v1/annotations.proto`. */
	readonly importPath: string;
	readonly packageName: string;
}

/**
 * Checks whether a proto type name is a built-in scalar.
 * @param type - Type name as written in the source
 * @returns True when the type can never have an option body
 */
export function isScalar(type: string): boolean {
	return SCALARS.has(type);
}

/**
 * In-memory {@link AnnotationRegistry}.
 *
 * Track D feeds this during the index walk via {@link ingest}; the standalone
 * scanner in `scan.ts` feeds it the same way from node `fs`. Either path is
 * text-in, descriptors-out — the registry never reads a file itself and never
 * retains file text.
 */
export class AnnotationRegistryImpl implements AnnotationRegistry {
	private readonly descriptors = new Map<string, AnnotationDescriptor>();
	private readonly messages = new Map<string, ExtractedMessage>();
	private readonly enums = new Map<string, ExtractedEnum>();
	/**
	 * Value names per enum, kept beside {@link enums} rather than mapped on
	 * demand: `enumValues` is called once per keystroke that opens a completion
	 * list, and it returned a stored array before members carried their docs.
	 */
	private readonly enumNames = new Map<string, readonly string[]>();
	private readonly origins = new Map<number, AnnotationOrigin>();
	private readonly fileImports = new Map<string, readonly string[]>();
	private readonly fileKeys = new Map<
		number,
		{ annotations: string[]; messages: string[]; enums: string[] }
	>();

	private bodyCache = new Map<string, AnnotationBody | null>();
	private typeCache = new Map<string, string | null>();
	private targetCache?: Map<AnnotationTarget, AnnotationDescriptor[]>;
	private collisionCache?: readonly AnnotationCollision[];
	private orderedCache?: readonly AnnotationDescriptor[];

	/**
	 * Adds one file's contribution. Calling again with the same `fileId`
	 * replaces the previous contribution, which is what incremental re-index
	 * needs.
	 * @param file - Output of `extractAnnotations` for a single `.proto` file
	 */
	ingest(file: ExtractedFile): void {
		this.removeFile(file.fileId);
		const keys = {
			annotations: [] as string[],
			messages: [] as string[],
			enums: [] as string[],
		};

		this.origins.set(file.fileId, {
			path: file.path,
			importPath: file.importPath,
			packageName: file.packageName,
		});
		if (file.importPath) {
			this.fileImports.set(file.importPath, file.imports);
		}

		for (const annotation of file.annotations) {
			// The buf module cache holds several commits of the same module, so
			// the identical annotation shows up repeatedly. First declaration wins.
			if (!this.descriptors.has(annotation.fqn)) {
				this.descriptors.set(annotation.fqn, annotation);
				keys.annotations.push(annotation.fqn);
			}
		}
		for (const message of file.messages) {
			if (!this.messages.has(message.fqn)) {
				this.messages.set(message.fqn, message);
				keys.messages.push(message.fqn);
			}
		}
		for (const enumType of file.enums) {
			if (!this.enums.has(enumType.fqn)) {
				this.enums.set(enumType.fqn, enumType);
				this.enumNames.set(
					enumType.fqn,
					enumType.values.map((value) => value.name),
				);
				keys.enums.push(enumType.fqn);
			}
		}

		this.fileKeys.set(file.fileId, keys);
		this.invalidate();
	}

	/**
	 * Drops everything one file contributed.
	 * @param fileId - Index file id previously passed to {@link ingest}
	 */
	removeFile(fileId: number): void {
		const keys = this.fileKeys.get(fileId);
		if (!keys) {
			return;
		}
		for (const fqn of keys.annotations) {
			this.descriptors.delete(fqn);
		}
		for (const fqn of keys.messages) {
			this.messages.delete(fqn);
		}
		for (const fqn of keys.enums) {
			this.enums.delete(fqn);
			this.enumNames.delete(fqn);
		}
		this.fileKeys.delete(fileId);
		const origin = this.origins.get(fileId);
		if (origin?.importPath) {
			this.fileImports.delete(origin.importPath);
		}
		this.origins.delete(fileId);
		this.invalidate();
	}

	/** Empties the registry. */
	clear(): void {
		this.descriptors.clear();
		this.messages.clear();
		this.enums.clear();
		this.enumNames.clear();
		this.origins.clear();
		this.fileImports.clear();
		this.fileKeys.clear();
		this.invalidate();
	}

	/**
	 * Imports written by a file the registry has seen.
	 *
	 * Used to answer "does this buffer reach `mcp/v1/annotations.proto`?" without
	 * opening a single document: protoc needs the extension in the import
	 * closure, and re-exports via `import public` make the direct-import test
	 * alone too strict.
	 *
	 * @param importPath - Path as written in an `import` statement
	 * @returns That file's own imports, or undefined when it was never scanned
	 */
	importsOf(importPath: string): readonly string[] | undefined {
		return this.fileImports.get(importPath);
	}

	/**
	 * Declaration site of an annotation.
	 * @param descriptor - The annotation
	 * @returns Its file's path, import path and package
	 */
	siteOf(descriptor: AnnotationDescriptor): AnnotationOrigin | undefined {
		return this.origins.get(descriptor.fileId);
	}

	/** Number of option-body message shapes known. Used by diagnostics reporting. */
	messageCount(): number {
		return this.messages.size;
	}

	/** @inheritdoc */
	all(): readonly AnnotationDescriptor[] {
		if (!this.orderedCache) {
			this.orderedCache = [...this.descriptors.values()].sort((a, b) =>
				a.fqn < b.fqn ? -1 : a.fqn > b.fqn ? 1 : 0,
			);
		}
		return this.orderedCache;
	}

	/** @inheritdoc */
	get(fqn: string): AnnotationDescriptor | undefined {
		return this.descriptors.get(fqn);
	}

	/** @inheritdoc */
	byTarget(target: AnnotationTarget): readonly AnnotationDescriptor[] {
		if (!this.targetCache) {
			const map = new Map<AnnotationTarget, AnnotationDescriptor[]>();
			for (const descriptor of this.all()) {
				const list = map.get(descriptor.target);
				if (list) {
					list.push(descriptor);
				} else {
					map.set(descriptor.target, [descriptor]);
				}
			}
			this.targetCache = map;
		}
		return this.targetCache.get(target) ?? [];
	}

	/** @inheritdoc */
	body(descriptor: AnnotationDescriptor): AnnotationBody | undefined {
		const fqn = this.resolveTypeFqn(descriptor.type, descriptor.namespace);
		return fqn ? this.bodyOf(fqn) : undefined;
	}

	/** @inheritdoc */
	collisions(): readonly AnnotationCollision[] {
		if (this.collisionCache) {
			return this.collisionCache;
		}
		const slots = new Map<string, AnnotationDescriptor[]>();
		for (const descriptor of this.all()) {
			const key = `${descriptor.target}#${descriptor.number}`;
			const list = slots.get(key);
			if (list) {
				list.push(descriptor);
			} else {
				slots.set(key, [descriptor]);
			}
		}
		const out: AnnotationCollision[] = [];
		for (const claimants of slots.values()) {
			if (claimants.length > 1) {
				out.push({
					target: claimants[0].target,
					number: claimants[0].number,
					claimants,
				});
			}
		}
		this.collisionCache = out;
		return out;
	}

	/**
	 * Resolves a message fqn to its option-body shape, memoised.
	 * @param messageFqn - Fully-qualified message name
	 * @returns Its fields, or undefined when the message was never indexed
	 */
	bodyOf(messageFqn: string): AnnotationBody | undefined {
		const cached = this.bodyCache.get(messageFqn);
		if (cached !== undefined) {
			return cached ?? undefined;
		}
		const message = this.messages.get(messageFqn);
		if (!message) {
			this.bodyCache.set(messageFqn, null);
			return undefined;
		}
		const namespace = messageFqn.slice(0, messageFqn.lastIndexOf("."));
		const body: AnnotationBody = {
			fqn: messageFqn,
			fields: message.fields.map((field) => this.toField(field, namespace)),
		};
		this.bodyCache.set(messageFqn, body);
		return body;
	}

	/**
	 * Walks a dotted field path into an option body.
	 *
	 * `(cache.v1.cache) = { ttl: { seconds: 300 } }` hovered on `seconds` asks
	 * for `["ttl", "seconds"]`, which needs one hop through `ttl`'s own message.
	 *
	 * @param descriptor - The annotation whose body is being indexed into
	 * @param path - Field names from the body root
	 * @returns The field, or undefined when any hop is unknown
	 */
	fieldAt(
		descriptor: AnnotationDescriptor,
		path: readonly string[],
	): AnnotationField | undefined {
		if (path.length === 0) {
			return undefined;
		}
		let body = this.body(descriptor);
		let field: AnnotationField | undefined;
		for (const segment of path) {
			if (!body) {
				return undefined;
			}
			field = body.fields.find((candidate) => candidate.name === segment);
			if (!field) {
				return undefined;
			}
			body = field.messageFqn ? this.bodyOf(field.messageFqn) : undefined;
		}
		return field;
	}

	/**
	 * Body shape holding a given field path — what completion needs to list the
	 * legal names at the cursor.
	 * @param descriptor - The annotation being written
	 * @param path - Field names already entered, outermost first
	 * @returns The message whose fields are legal at that point
	 */
	bodyAt(
		descriptor: AnnotationDescriptor,
		path: readonly string[],
	): AnnotationBody | undefined {
		if (path.length === 0) {
			return this.body(descriptor);
		}
		const field = this.fieldAt(descriptor, path);
		return field?.messageFqn ? this.bodyOf(field.messageFqn) : undefined;
	}

	/**
	 * Values of a known enum, for generating completion choices.
	 * @param enumFqn - Fully-qualified enum name
	 * @returns Its value names, or undefined when unknown
	 */
	enumValues(enumFqn: string): readonly string[] | undefined {
		return this.enumNames.get(enumFqn);
	}

	/**
	 * Values of a known enum with their numbers and documentation.
	 * @param enumFqn - Fully-qualified enum name
	 * @returns Its members, or undefined when unknown
	 */
	enumMembers(enumFqn: string): readonly RawEnumValue[] | undefined {
		return this.enums.get(enumFqn)?.values;
	}

	/**
	 * A known enum's declaration, for the "defined in" footer on a value card.
	 * @param enumFqn - Fully-qualified enum name
	 * @returns The declaration, or undefined when unknown
	 */
	enumOf(enumFqn: string): ExtractedEnum | undefined {
		return this.enums.get(enumFqn);
	}

	/**
	 * Source of a file the registry has seen.
	 * @param fileId - Index file id
	 * @returns Its path, import path and package
	 */
	origin(fileId: number): AnnotationOrigin | undefined {
		return this.origins.get(fileId);
	}

	/**
	 * Resolves a type name written inside a `.proto` to a fully-qualified name,
	 * using protobuf's innermost-scope-first rule, simplified to the two cases
	 * that occur in option declarations.
	 * @param type - Type name as written
	 * @param namespace - Package of the file that wrote it
	 * @returns The fqn of a known message, or undefined
	 */
	resolveTypeFqn(type: string, namespace: string): string | undefined {
		if (isScalar(type) || type.startsWith("map<")) {
			return undefined;
		}
		const cacheKey = `${namespace}|${type}`;
		const cached = this.typeCache.get(cacheKey);
		if (cached !== undefined) {
			return cached ?? undefined;
		}
		const resolved = this.resolveTypeFqnUncached(type, namespace);
		this.typeCache.set(cacheKey, resolved ?? null);
		return resolved;
	}

	private resolveTypeFqnUncached(
		type: string,
		namespace: string,
	): string | undefined {
		const bare = type.startsWith(".") ? type.slice(1) : type;
		if (this.messages.has(bare)) {
			return bare;
		}
		// Walk outwards through the declaring package: `a.b.c` + `Foo` tries
		// `a.b.c.Foo`, then `a.b.Foo`, then `a.Foo`.
		let scope = namespace;
		while (scope.length > 0) {
			const candidate = `${scope}.${bare}`;
			if (this.messages.has(candidate)) {
				return candidate;
			}
			const cut = scope.lastIndexOf(".");
			if (cut < 0) {
				break;
			}
			scope = scope.slice(0, cut);
		}
		// Last resort: a unique suffix match. Option bodies almost always live
		// beside the extend block, so this rarely fires.
		let found: string | undefined;
		const suffix = `.${bare}`;
		for (const fqn of this.messages.keys()) {
			if (fqn.endsWith(suffix)) {
				if (found) {
					return undefined;
				}
				found = fqn;
			}
		}
		return found;
	}

	/**
	 * Resolves an enum type name the same way {@link resolveTypeFqn} resolves
	 * messages.
	 * @param type - Type name as written
	 * @param namespace - Package of the file that wrote it
	 * @returns The fqn of a known enum, or undefined
	 */
	resolveEnumFqn(type: string, namespace: string): string | undefined {
		if (isScalar(type)) {
			return undefined;
		}
		const bare = type.startsWith(".") ? type.slice(1) : type;
		if (this.enums.has(bare)) {
			return bare;
		}
		let scope = namespace;
		while (scope.length > 0) {
			const candidate = `${scope}.${bare}`;
			if (this.enums.has(candidate)) {
				return candidate;
			}
			const cut = scope.lastIndexOf(".");
			if (cut < 0) {
				break;
			}
			scope = scope.slice(0, cut);
		}
		return undefined;
	}

	/** Every namespace that declares at least one annotation. */
	namespaces(): readonly string[] {
		const set = new Set<string>();
		for (const descriptor of this.descriptors.values()) {
			set.add(descriptor.namespace);
		}
		return [...set].sort();
	}

	private toField(field: RawField, namespace: string): AnnotationField {
		const messageFqn = this.resolveTypeFqn(field.type, namespace);
		return {
			name: field.name,
			type: field.type,
			number: field.number,
			repeated: field.repeated,
			doc: field.doc,
			messageFqn,
		};
	}

	private invalidate(): void {
		this.bodyCache = new Map();
		this.typeCache = new Map();
		this.targetCache = undefined;
		this.collisionCache = undefined;
		this.orderedCache = undefined;
	}
}
