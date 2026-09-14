/**
 * Diagnostics for custom options.
 *
 * Five checks, each of which catches something protoc would reject but that no
 * amount of syntax highlighting can see:
 *
 * 1. an option no indexed `extend` block declares;
 * 2. an option applied to the wrong element — a `MethodOptions` extension on a
 *    message;
 * 3. a field name that the option body message does not have;
 * 4. an option whose `annotations.proto` is not in the file's import closure;
 * 5. two annotations claiming one extension number, reported **only** when this
 *    file actually reaches both. The `entity.v1` / `protokit.v1` overlap in this
 *    workspace is a deliberate migration: flagging it globally would put a
 *    permanent error on files that are entirely correct, so the registry
 *    reports the claim and this file decides whether it bites.
 *
 * Everything is conservative in the same direction. An empty registry produces
 * no diagnostics at all, and an import closure that could not be computed in
 * full suppresses the checks that depend on proving something *absent*.
 */

import * as vscode from "vscode";
import type { AnnotationDescriptor } from "../index/types";
import type { ProtoDocumentModel } from "./document";
import { targetLabel } from "./markdown";
import type { AnnotationRegistryImpl } from "./registry";
import {
	type AnnotationSource,
	analyzeCached,
	forgetAnalysis,
	type ImportClosure,
	importClosure,
	knownNamespaceFor,
	resolveDescriptor,
	suggestAnnotation,
} from "./resolve";

/** Diagnostic codes, stable so a future quick fix can match on them. */
export const ANNOTATION_DIAGNOSTIC_CODES = {
	unknown: "proto.annotation.unknown",
	wrongTarget: "proto.annotation.wrongTarget",
	unknownField: "proto.annotation.unknownField",
	missingImport: "proto.annotation.missingImport",
	numberCollision: "proto.annotation.numberCollision",
} as const;

/** `source` shown beside every diagnostic this module produces. */
export const ANNOTATION_DIAGNOSTIC_SOURCE = "proto-annotations";

/** Milliseconds of quiet before a changed buffer is re-validated. */
const DEBOUNCE_MS = 300;

/**
 * Whether a document is a proto file this module should validate.
 * @param document - Any open document
 * @returns True for proto buffers
 */
function isProtoDocument(document: vscode.TextDocument): boolean {
	return (
		document.languageId === "proto3" ||
		document.languageId === "proto" ||
		document.uri.path.endsWith(".proto")
	);
}

/** Validates annotation usage in open proto buffers. */
export class AnnotationDiagnostics implements vscode.Disposable {
	private readonly collection: vscode.DiagnosticCollection;
	private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly listeners: vscode.Disposable[] = [];

	constructor(private readonly source: AnnotationSource) {
		this.collection = vscode.languages.createDiagnosticCollection(
			ANNOTATION_DIAGNOSTIC_SOURCE,
		);
	}

	/**
	 * Subscribes to document and index events and validates what is already open.
	 */
	start(): void {
		this.listeners.push(
			vscode.workspace.onDidOpenTextDocument((document) =>
				this.validate(document),
			),
			vscode.workspace.onDidChangeTextDocument((event) =>
				this.schedule(event.document),
			),
			vscode.workspace.onDidSaveTextDocument((document) =>
				this.validate(document),
			),
			vscode.workspace.onDidCloseTextDocument((document) => {
				this.collection.delete(document.uri);
				forgetAnalysis(document.uri.toString());
				const key = document.uri.toString();
				const timer = this.timers.get(key);
				if (timer) {
					clearTimeout(timer);
					this.timers.delete(key);
				}
			}),
			// A rebuild changes what is known, so every open buffer's verdict may
			// change without the buffer itself being touched.
			this.source.onDidChange(() => this.refreshAll()),
		);
		this.refreshAll();
	}

	/** Re-validates every open proto buffer. */
	refreshAll(): void {
		for (const document of vscode.workspace.textDocuments) {
			this.validate(document);
		}
	}

	/**
	 * Queues a validation after the user stops typing.
	 * @param document - The buffer that changed
	 */
	private schedule(document: vscode.TextDocument): void {
		if (!isProtoDocument(document)) {
			return;
		}
		const key = document.uri.toString();
		const existing = this.timers.get(key);
		if (existing) {
			clearTimeout(existing);
		}
		this.timers.set(
			key,
			setTimeout(() => {
				this.timers.delete(key);
				this.validate(document);
			}, DEBOUNCE_MS),
		);
	}

	/**
	 * Validates one buffer and publishes its diagnostics.
	 * @param document - The buffer to validate
	 */
	validate(document: vscode.TextDocument): void {
		if (!isProtoDocument(document)) {
			return;
		}
		const registry = this.source.registry();
		// An empty registry means the index has not run, not that every annotation
		// in the file is wrong.
		if (!registry || !this.source.ready()) {
			this.collection.delete(document.uri);
			return;
		}
		const model = analyzeCached(
			document.uri.toString(),
			document.version,
			document.getText(),
		);
		const closure = importClosure(
			registry,
			model.imports.map((entry) => entry.path),
		);
		const out: vscode.Diagnostic[] = [];
		this.checkOptions(document, model, registry, closure, out);
		this.checkBodyFields(document, model, registry, out);
		this.checkCollisions(document, model, registry, closure, out);
		this.collection.set(document.uri, out);
	}

	/** Releases the collection, listeners and pending timers. */
	dispose(): void {
		for (const timer of this.timers.values()) {
			clearTimeout(timer);
		}
		this.timers.clear();
		for (const listener of this.listeners) {
			listener.dispose();
		}
		this.listeners.length = 0;
		this.collection.dispose();
	}

	/**
	 * Checks unknown names, wrong targets and missing imports.
	 * @param document - The buffer
	 * @param model - Structural model of the buffer
	 * @param registry - The annotation registry
	 * @param closure - The file's import closure
	 * @param out - Array to append diagnostics to
	 */
	private checkOptions(
		document: vscode.TextDocument,
		model: ProtoDocumentModel,
		registry: AnnotationRegistryImpl,
		closure: ImportClosure,
		out: vscode.Diagnostic[],
	): void {
		for (const reference of model.options) {
			const range = new vscode.Range(
				document.positionAt(reference.nameStart),
				document.positionAt(reference.nameEnd),
			);
			const descriptor = resolveDescriptor(
				registry,
				reference.fqn,
				model.packageName,
			);
			if (!descriptor) {
				// A file may use an extension it declares itself before that file has
				// ever been scanned; that is not an error.
				if (this.declaredHere(model, reference.fqn)) {
					continue;
				}
				out.push(this.unknownDiagnostic(range, reference.fqn, registry));
				continue;
			}

			if (reference.target && reference.target !== descriptor.target) {
				out.push(
					this.make(
						range,
						`\`(${descriptor.fqn})\` is a ${targetLabel(descriptor.target)} option and cannot be applied to a ${targetLabel(reference.target)}.`,
						vscode.DiagnosticSeverity.Error,
						ANNOTATION_DIAGNOSTIC_CODES.wrongTarget,
					),
				);
			}

			if (this.importMissing(document, model, registry, closure, descriptor)) {
				out.push(
					this.make(
						range,
						`\`(${descriptor.fqn})\` is declared in "${descriptor.importPath}", which this file does not import.`,
						vscode.DiagnosticSeverity.Error,
						ANNOTATION_DIAGNOSTIC_CODES.missingImport,
					),
				);
			}
		}
	}

	/**
	 * Checks that every field written in an option body exists on the body
	 * message.
	 * @param document - The buffer
	 * @param model - Structural model of the buffer
	 * @param registry - The annotation registry
	 * @param out - Array to append diagnostics to
	 */
	private checkBodyFields(
		document: vscode.TextDocument,
		model: ProtoDocumentModel,
		registry: AnnotationRegistryImpl,
		out: vscode.Diagnostic[],
	): void {
		for (const field of model.bodyFields) {
			const descriptor = resolveDescriptor(
				registry,
				field.optionFqn,
				model.packageName,
			);
			if (!descriptor || field.path.length === 0) {
				continue;
			}
			// Only judge a field whose containing message is actually known —
			// otherwise one unresolved parent would condemn every field under it.
			const parent = registry.bodyAt(descriptor, field.path.slice(0, -1));
			if (!parent) {
				continue;
			}
			const name = field.path[field.path.length - 1];
			if (parent.fields.some((candidate) => candidate.name === name)) {
				continue;
			}
			out.push(
				this.make(
					new vscode.Range(
						document.positionAt(field.start),
						document.positionAt(field.end),
					),
					`\`${name}\` is not a field of \`${parent.fqn}\`.`,
					vscode.DiagnosticSeverity.Error,
					ANNOTATION_DIAGNOSTIC_CODES.unknownField,
				),
			);
		}
	}

	/**
	 * Reports an extension-number collision only when this file reaches both
	 * claimants.
	 * @param document - The buffer
	 * @param model - Structural model of the buffer
	 * @param registry - The annotation registry
	 * @param closure - The file's import closure
	 * @param out - Array to append diagnostics to
	 */
	private checkCollisions(
		document: vscode.TextDocument,
		model: ProtoDocumentModel,
		registry: AnnotationRegistryImpl,
		closure: ImportClosure,
		out: vscode.Diagnostic[],
	): void {
		for (const collision of registry.collisions()) {
			const reached = collision.claimants.filter(
				(claimant) =>
					claimant.importPath !== "" && closure.paths.has(claimant.importPath),
			);
			const paths = new Set(reached.map((claimant) => claimant.importPath));
			if (paths.size < 2) {
				continue;
			}
			const anchor = this.collisionAnchor(document, model, reached);
			if (!anchor) {
				continue;
			}
			const names = reached
				.map((claimant) => `\`(${claimant.fqn})\` ("${claimant.importPath}")`)
				.join(" and ");
			const diagnostic = this.make(
				anchor,
				`Extension number ${collision.number} on ${targetLabel(collision.target)} options is claimed by ${names}. Protobuf requires it to be unique, so these cannot be imported together.`,
				vscode.DiagnosticSeverity.Error,
				ANNOTATION_DIAGNOSTIC_CODES.numberCollision,
			);
			diagnostic.relatedInformation = reached.flatMap((claimant) => {
				const site = registry.siteOf(claimant);
				if (!site?.path) {
					return [];
				}
				return [
					new vscode.DiagnosticRelatedInformation(
						new vscode.Location(
							vscode.Uri.file(site.path),
							new vscode.Position(claimant.line, 0),
						),
						`\`${claimant.fqn}\` claims ${collision.number} here`,
					),
				];
			});
			out.push(diagnostic);
		}
	}

	/**
	 * Picks where to put a collision diagnostic: the import that pulled the
	 * second claimant in, failing that a use of one of them.
	 * @param document - The buffer
	 * @param model - Structural model of the buffer
	 * @param reached - Claimants this file reaches
	 * @returns A range, or undefined when nothing in the file relates to it
	 */
	private collisionAnchor(
		document: vscode.TextDocument,
		model: ProtoDocumentModel,
		reached: readonly AnnotationDescriptor[],
	): vscode.Range | undefined {
		const wanted = new Set(reached.map((claimant) => claimant.importPath));
		const direct = model.imports.filter((entry) => wanted.has(entry.path));
		const chosen = direct[direct.length - 1];
		if (chosen) {
			return new vscode.Range(
				document.positionAt(chosen.start),
				document.positionAt(chosen.end),
			);
		}
		const names = new Set(reached.map((claimant) => claimant.fqn));
		for (const reference of model.options) {
			if (names.has(reference.fqn)) {
				return new vscode.Range(
					document.positionAt(reference.nameStart),
					document.positionAt(reference.nameEnd),
				);
			}
		}
		const first = model.imports[0];
		return first
			? new vscode.Range(
					document.positionAt(first.start),
					document.positionAt(first.end),
				)
			: undefined;
	}

	/**
	 * Builds the diagnostic for an option nothing declares, with a suggestion
	 * when the namespace exists and only the name is off.
	 * @param range - Range of the written name
	 * @param written - The name as written
	 * @param registry - The annotation registry
	 * @returns The diagnostic
	 */
	private unknownDiagnostic(
		range: vscode.Range,
		written: string,
		registry: AnnotationRegistryImpl,
	): vscode.Diagnostic {
		const namespace = knownNamespaceFor(registry, written);
		if (!namespace) {
			// No indexed namespace matches, so the declaring module may simply be
			// outside the index rather than the name being wrong.
			return this.make(
				range,
				`No indexed \`extend\` block declares \`(${written})\`.`,
				vscode.DiagnosticSeverity.Warning,
				ANNOTATION_DIAGNOSTIC_CODES.unknown,
			);
		}
		const suggestion = suggestAnnotation(registry, written, namespace);
		const hint = suggestion ? ` Did you mean \`(${suggestion})\`?` : "";
		return this.make(
			range,
			`\`${namespace}\` declares no option named \`${written.slice(namespace.length + 1)}\`.${hint}`,
			vscode.DiagnosticSeverity.Error,
			ANNOTATION_DIAGNOSTIC_CODES.unknown,
		);
	}

	/**
	 * Whether an annotation's declaring file is outside this file's import
	 * closure.
	 * @param document - The buffer
	 * @param model - Structural model of the buffer
	 * @param registry - The annotation registry
	 * @param closure - The file's import closure
	 * @param descriptor - The annotation being used
	 * @returns True only when the absence can be proven
	 */
	private importMissing(
		document: vscode.TextDocument,
		model: ProtoDocumentModel,
		registry: AnnotationRegistryImpl,
		closure: ImportClosure,
		descriptor: AnnotationDescriptor,
	): boolean {
		if (!closure.complete || descriptor.importPath === "") {
			return false;
		}
		if (closure.paths.has(descriptor.importPath)) {
			return false;
		}
		if (this.declaredHere(model, descriptor.fqn)) {
			return false;
		}
		const site = registry.siteOf(descriptor);
		return site?.path !== document.uri.fsPath;
	}

	/**
	 * Whether the buffer's own `extend` blocks declare this option.
	 * @param model - Structural model of the buffer
	 * @param written - The option name as written
	 * @returns True when the file declares it itself
	 */
	private declaredHere(model: ProtoDocumentModel, written: string): boolean {
		const leaf = written.slice(written.lastIndexOf(".") + 1);
		return model.declarations.some((declaration) => declaration.name === leaf);
	}

	/**
	 * Builds one diagnostic with this module's source and a stable code.
	 * @param range - Range to underline
	 * @param message - Message text
	 * @param severity - Severity
	 * @param code - One of {@link ANNOTATION_DIAGNOSTIC_CODES}
	 * @returns The diagnostic
	 */
	private make(
		range: vscode.Range,
		message: string,
		severity: vscode.DiagnosticSeverity,
		code: string,
	): vscode.Diagnostic {
		const diagnostic = new vscode.Diagnostic(range, message, severity);
		diagnostic.source = ANNOTATION_DIAGNOSTIC_SOURCE;
		diagnostic.code = code;
		return diagnostic;
	}
}
