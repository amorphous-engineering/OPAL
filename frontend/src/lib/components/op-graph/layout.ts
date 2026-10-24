import dagre from '@dagrejs/dagre';
import type { GraphEdge, GraphNode } from './types.js';

export const NODE_WIDTH = 220;
export const NODE_HEIGHT = 56;

/** Left-to-right layered layout; returns top-left positions by node id. */
export function layoutGraph(
	nodes: GraphNode[],
	edges: GraphEdge[]
): Map<number, { x: number; y: number }> {
	const g = new dagre.graphlib.Graph();
	g.setGraph({ rankdir: 'LR', ranksep: 64, nodesep: 10, marginx: 8, marginy: 8 });
	g.setDefaultEdgeLabel(() => ({}));
	const ids = new Set(nodes.map((n) => n.id));
	for (const n of nodes) g.setNode(String(n.id), { width: NODE_WIDTH, height: NODE_HEIGHT });
	for (const e of edges) {
		if (ids.has(e.from) && ids.has(e.to) && e.from !== e.to)
			g.setEdge(String(e.from), String(e.to));
	}
	dagre.layout(g);
	const out = new Map<number, { x: number; y: number }>();
	for (const n of nodes) {
		const p = g.node(String(n.id));
		out.set(n.id, { x: p.x - NODE_WIDTH / 2, y: p.y - NODE_HEIGHT / 2 });
	}
	return out;
}
