import type { GraphEdge } from './types.js';

/** True when adding the edge from -> to would close a loop (including a self-loop). */
export function wouldCycle(edges: GraphEdge[], from: number, to: number): boolean {
	if (from === to) return true;
	const next = new Map<number, number[]>();
	for (const e of edges) {
		const list = next.get(e.from);
		if (list) list.push(e.to);
		else next.set(e.from, [e.to]);
	}
	// A loop exists when `from` is already reachable from `to`.
	const seen = new Set<number>([to]);
	const stack = [to];
	while (stack.length) {
		const id = stack.pop()!;
		if (id === from) return true;
		for (const n of next.get(id) ?? []) {
			if (!seen.has(n)) {
				seen.add(n);
				stack.push(n);
			}
		}
	}
	return false;
}
