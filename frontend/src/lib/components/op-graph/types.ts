import type { Snippet } from 'svelte';

export type GraphNodeKind = 'op' | 'contingency' | 'redline';

export interface GraphNode {
	/** The OP's document `order`. */
	id: number;
	/** "1", "C1", "2R1" */
	number: string;
	title: string;
	kind: GraphNodeKind;
	/** Execution status (pending | in_progress | completed | skipped | blocked | ...); absent in authoring. */
	status?: string;
	progress?: { done: number; total: number };
	/** Short state words shown on the node, e.g. "HELD", "NC", "WAITING". */
	flags?: string[];
}

export interface GraphEdge {
	/** Prerequisite node id. */
	from: number;
	/** Dependent node id. */
	to: number;
	/** redline: dashed, warn colour, never editable. */
	kind?: 'dependency' | 'redline';
}

/** Internal: payload of a Svelte Flow node. */
export interface OpNodeData extends Record<string, unknown> {
	node: GraphNode;
	selected: boolean;
	flash: boolean;
	editable: boolean;
	actions?: Snippet<[GraphNode]>;
}

/** Internal: payload of a Svelte Flow edge. */
export interface OpEdgeData extends Record<string, unknown> {
	redline: boolean;
	editable: boolean;
	onremove: () => void;
}
