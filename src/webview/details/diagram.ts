/**
 * Diagram layout for a proto symbol.
 *
 * Mermaid would draw these, at 5.1 MB minified — thirteen times the whole
 * extension — to lay out graphs whose shape is known in advance. A service is
 * always three columns (service, method, type) and a message is always two, so
 * the layout that needs a general solver is the one we never have.
 *
 * Everything here is pure geometry over a {@link SymbolDetail}. Colour and type
 * belong to the component that renders it, so a node carries a token name, not
 * a hex value.
 */

import type { SymbolDetail } from "../../shared/protocol";

/** Width of one column of boxes. */
const NODE_W = 168;
/** Height of one box. */
const NODE_H = 30;
/** Vertical gap between boxes in a column. */
const GAP_Y = 12;
/** Horizontal gap between columns, where the edges live. */
const GAP_X = 68;
/** Padding around the whole drawing. */
const PAD = 12;

/** How many rows to draw before saying "+N more". */
const MAX_ROWS = 14;

/** One box. */
export interface DiagramNode {
	readonly id: string;
	readonly label: string;
	/** Secondary line inside the box, e.g. a field number or an HTTP verb. */
	readonly sub?: string;
	readonly x: number;
	readonly y: number;
	readonly w: number;
	readonly h: number;
	/** Theme token suffix — `sym-class`, `sym-method`, `danger`, `muted`. */
	readonly tone: string;
	/** Findings attributed to whatever this box stands for. */
	readonly problems: number;
	/** Zero-based line to reveal when the box is clicked. */
	readonly line?: number;
}

/** One connector, drawn as a cubic curve between two columns. */
export interface DiagramEdge {
	readonly id: string;
	readonly path: string;
	/** Drawn on the curve's midpoint, e.g. `returns`. */
	readonly label?: string;
	readonly dashed: boolean;
}

/** A laid-out drawing, sized to its contents. */
export interface Diagram {
	readonly kind: "service" | "message" | "none";
	readonly width: number;
	readonly height: number;
	readonly nodes: readonly DiagramNode[];
	readonly edges: readonly DiagramEdge[];
	/** Set when rows were dropped to keep the drawing readable. */
	readonly truncated?: string;
}

/** Nothing worth drawing. */
const EMPTY: Diagram = {
	kind: "none",
	width: 0,
	height: 0,
	nodes: [],
	edges: [],
};

/** A cubic curve from the right edge of one box to the left edge of another. */
function connect(from: DiagramNode, to: DiagramNode): string {
	const x1 = from.x + from.w;
	const y1 = from.y + from.h / 2;
	const x2 = to.x;
	const y2 = to.y + to.h / 2;
	// Control points sit halfway across the gap, so curves leave and enter
	// horizontally and never cross a box they are not connected to.
	const cx = (x2 - x1) / 2;
	return `M ${x1} ${y1} C ${x1 + cx} ${y1}, ${x2 - cx} ${y2}, ${x2} ${y2}`;
}

/** The last dotted segment of a type name, which is what a reader scans for. */
function shortType(type: string): string {
	const bare = type.replace(/^\./, "");
	const cut = bare.lastIndexOf(".");
	return cut === -1 ? bare : bare.slice(cut + 1);
}

/**
 * Well-known types are drawn muted.
 *
 * `google.protobuf.Timestamp` is never the thing under review; dimming it keeps
 * the reader's eye on the workspace's own messages.
 */
function isWellKnown(type: string): boolean {
	return type.replace(/^\./, "").startsWith("google.");
}

/**
 * A service as service → method → type.
 *
 * Request and response share the third column and are deduplicated: a service
 * where five methods return `Book` should draw one `Book`, because that shared
 * box is the fact worth seeing.
 */
function layoutService(detail: SymbolDetail): Diagram {
	const rpcs = detail.rpcs.slice(0, MAX_ROWS);
	if (rpcs.length === 0) {
		return EMPTY;
	}

	const nodes: DiagramNode[] = [];
	const edges: DiagramEdge[] = [];

	const rowsH = rpcs.length * NODE_H + (rpcs.length - 1) * GAP_Y;

	const colX = [PAD, PAD + NODE_W + GAP_X, PAD + (NODE_W + GAP_X) * 2];

	// Column 1: the service, centred against the method column.
	const service: DiagramNode = {
		id: "service",
		label: detail.name,
		sub: detail.package,
		x: colX[0],
		y: PAD + Math.max(0, (rowsH - NODE_H) / 2),
		w: NODE_W,
		h: NODE_H,
		tone: "sym-iface",
		problems: 0,
		line: detail.loc.line,
	};
	nodes.push(service);

	// Column 3 is built first so each method can point at a shared box.
	const typeIndex = new Map<string, DiagramNode>();
	const typeOrder: string[] = [];
	for (const rpc of rpcs) {
		for (const type of [rpc.requestType, rpc.responseType]) {
			if (!typeIndex.has(type)) {
				typeIndex.set(type, undefined as unknown as DiagramNode);
				typeOrder.push(type);
			}
		}
	}
	const typesH = typeOrder.length * NODE_H + (typeOrder.length - 1) * GAP_Y;
	typeOrder.forEach((type, row) => {
		const node: DiagramNode = {
			id: `type:${type}`,
			label: shortType(type),
			sub: isWellKnown(type) ? "well-known" : undefined,
			x: colX[2],
			y: PAD + row * (NODE_H + GAP_Y),
			w: NODE_W,
			h: NODE_H,
			tone: isWellKnown(type) ? "muted" : "sym-class",
			problems: 0,
		};
		typeIndex.set(type, node);
		nodes.push(node);
	});

	// Column 2: one box per method, offset so both columns share a centre.
	const methodOffset = Math.max(0, (typesH - rowsH) / 2);
	rpcs.forEach((rpc, row) => {
		const node: DiagramNode = {
			id: `rpc:${rpc.name}`,
			label: rpc.name,
			sub: rpc.httpRule,
			x: colX[1],
			y: PAD + methodOffset + row * (NODE_H + GAP_Y),
			w: NODE_W,
			h: NODE_H,
			tone: rpc.problemCount > 0 ? "danger" : "sym-method",
			problems: rpc.problemCount,
			line: rpc.loc.line,
		};
		nodes.push(node);

		edges.push({
			id: `e:svc:${rpc.name}`,
			path: connect(service, node),
			dashed: false,
		});
		const request = typeIndex.get(rpc.requestType);
		if (request) {
			edges.push({
				id: `e:${rpc.name}:req`,
				path: connect(node, request),
				dashed: false,
			});
		}
		const response = typeIndex.get(rpc.responseType);
		if (response && rpc.responseType !== rpc.requestType) {
			edges.push({
				id: `e:${rpc.name}:res`,
				path: connect(node, response),
				label: "returns",
				dashed: true,
			});
		}
	});

	// The service box is centred against whichever column ended up taller.
	const serviceY = PAD + Math.max(0, (Math.max(rowsH, typesH) - NODE_H) / 2);
	nodes[0] = { ...service, y: serviceY };
	for (let i = 0; i < edges.length; i++) {
		const edge = edges[i];
		if (edge.id.startsWith("e:svc:")) {
			const target = nodes.find(
				(node) => node.id === `rpc:${edge.id.slice("e:svc:".length)}`,
			);
			if (target) {
				edges[i] = { ...edge, path: connect(nodes[0], target) };
			}
		}
	}

	return {
		kind: "service",
		width: colX[2] + NODE_W + PAD,
		height: PAD * 2 + Math.max(rowsH, typesH, NODE_H),
		nodes,
		edges,
		truncated:
			detail.rpcs.length > rpcs.length
				? `${detail.rpcs.length - rpcs.length} more RPC(s) not drawn`
				: undefined,
	};
}

/**
 * A message as message → the types its fields point at.
 *
 * Scalar fields are deliberately left out: `string name = 1` is a row in the
 * field table, not an edge in a graph, and drawing every one of them buries
 * the references that actually connect this message to the rest of the API.
 */
function layoutMessage(detail: SymbolDetail): Diagram {
	const SCALARS = new Set([
		"double", "float", "int32", "int64", "uint32", "uint64", "sint32",
		"sint64", "fixed32", "fixed64", "sfixed32", "sfixed64", "bool",
		"string", "bytes",
	]);

	const refs = detail.fields.filter(
		(field) => !SCALARS.has(field.type.replace(/^\./, "")),
	);
	const shown = refs.slice(0, MAX_ROWS);
	if (shown.length === 0) {
		return EMPTY;
	}

	const nodes: DiagramNode[] = [];
	const edges: DiagramEdge[] = [];
	const rowsH = shown.length * NODE_H + (shown.length - 1) * GAP_Y;
	const colX = [PAD, PAD + NODE_W + GAP_X];

	const message: DiagramNode = {
		id: "message",
		label: detail.name,
		sub: detail.isResource ? "resource" : detail.package,
		x: colX[0],
		y: PAD + Math.max(0, (rowsH - NODE_H) / 2),
		w: NODE_W,
		h: NODE_H,
		tone: "sym-class",
		problems: 0,
		line: detail.loc.line,
	};
	nodes.push(message);

	shown.forEach((field, row) => {
		const node: DiagramNode = {
			id: `field:${field.name}`,
			label: shortType(field.type),
			sub: `${field.repeated ? "repeated " : ""}${field.name}`,
			x: colX[1],
			y: PAD + row * (NODE_H + GAP_Y),
			w: NODE_W,
			h: NODE_H,
			tone: isWellKnown(field.type) ? "muted" : "sym-field",
			problems: field.problemCount,
			line: field.loc.line,
		};
		nodes.push(node);
		edges.push({
			id: `e:${field.name}`,
			path: connect(message, node),
			label: field.repeated ? "many" : undefined,
			dashed: field.repeated,
		});
	});

	return {
		kind: "message",
		width: colX[1] + NODE_W + PAD,
		height: PAD * 2 + Math.max(rowsH, NODE_H),
		nodes,
		edges,
		truncated:
			refs.length > shown.length
				? `${refs.length - shown.length} more reference(s) not drawn`
				: undefined,
	};
}

/**
 * The drawing for one symbol, or an empty one when there is nothing to draw.
 *
 * @param detail - The selected symbol
 * @returns A laid-out diagram; `kind: "none"` when a picture adds nothing
 */
export function layout(detail: SymbolDetail | null): Diagram {
	if (!detail) {
		return EMPTY;
	}
	if (detail.kind === "service") {
		return layoutService(detail);
	}
	if (detail.kind === "message") {
		return layoutMessage(detail);
	}
	return EMPTY;
}

/**
 * The same graph as Mermaid source.
 *
 * Rendering Mermaid in the panel would cost 5.1 MB of bundle to lay out graphs
 * this file already lays out. Emitting the source instead costs nothing and is
 * worth more: it pastes into a pull request, a README or an issue, where a
 * picture drawn here could never go.
 *
 * @param detail - The selected symbol
 * @returns A `graph LR` block, or `undefined` when there is nothing to draw
 */
export function toMermaid(detail: SymbolDetail | null): string | undefined {
	if (!detail) {
		return undefined;
	}

	/** Mermaid node ids may not contain dots or dashes. */
	const id = (value: string): string => value.replace(/[^\w]/g, "_");
	const lines = ["graph LR"];

	if (detail.kind === "service" && detail.rpcs.length > 0) {
		lines.push(`  ${id(detail.name)}["${detail.name}"]`);
		for (const rpc of detail.rpcs) {
			const rpcId = `${id(detail.name)}_${id(rpc.name)}`;
			lines.push(`  ${id(detail.name)} --> ${rpcId}["${rpc.name}"]`);
			lines.push(
				`  ${rpcId} --> ${id(rpc.requestType)}["${shortType(rpc.requestType)}"]`,
			);
			lines.push(
				`  ${rpcId} -.->|returns| ${id(rpc.responseType)}["${shortType(rpc.responseType)}"]`,
			);
		}
		return lines.join("\n");
	}

	if (detail.kind === "message") {
		const SCALARS = /^(double|float|u?int(32|64)|s?fixed(32|64)|sint(32|64)|bool|string|bytes)$/;
		const refs = detail.fields.filter(
			(field) => !SCALARS.test(field.type.replace(/^\./, "")),
		);
		if (refs.length === 0) {
			return undefined;
		}
		lines.push(`  ${id(detail.name)}["${detail.name}"]`);
		for (const field of refs) {
			const arrow = field.repeated ? "-.->|many|" : "-->";
			lines.push(
				`  ${id(detail.name)} ${arrow} ${id(field.type)}["${shortType(field.type)}"]`,
			);
		}
		return lines.join("\n");
	}

	return undefined;
}
