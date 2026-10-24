<script lang="ts">
	// The OP dependency graph of a template. Maps the AuthorStore document to graph nodes
	// and edges; connects and disconnects save through the store's setDependencies, which
	// toasts server refusals and restores the previous prerequisites.
	import { Button } from '#lib/components/ui/button/index.js';
	import { OpGraph, type GraphEdge, type GraphNode } from '#lib/components/op-graph/index.js';
	import type { AuthorStore } from '#lib/authoring/store.svelte.js';

	let {
		store,
		editable,
		onopen
	}: {
		store: AuthorStore;
		editable: boolean;
		onopen: (order: number) => void;
	} = $props();

	const all = $derived([...store.doc.ops, ...store.doc.contingency]);

	const ids = $derived(new Set(all.map((o) => o.order)));

	const nodes = $derived<GraphNode[]>([
		...store.doc.ops.map((o) => ({
			id: o.order,
			number: o.number,
			title: o.title,
			kind: 'op' as const
		})),
		...store.doc.contingency.map((o) => ({
			id: o.order,
			number: o.number,
			title: o.title,
			kind: 'contingency' as const
		}))
	]);

	const edges = $derived<GraphEdge[]>(
		all.flatMap((o) =>
			(o.depends_on ?? [])
				.filter((from) => ids.has(from))
				.map((from) => ({ from, to: o.order, kind: 'dependency' as const }))
		)
	);

	// Same selection the Operations nav shows.
	const selected = $derived(
		store.focusMode
			? store.focusOp
			: store.focusedOrder === null
				? null
				: (store.findStep(store.focusedOrder)?.op.order ?? null)
	);

	function select(id: number) {
		store.setFocus(id);
		if (store.focusMode) store.focusOp = id;
	}

	function connect(from: number, to: number) {
		const op = all.find((o) => o.order === to);
		if (!op) return;
		const have = op.depends_on ?? [];
		if (have.includes(from)) return;
		return store.setDependencies(op, [...have, from]);
	}

	function disconnect(from: number, to: number) {
		const op = all.find((o) => o.order === to);
		if (!op) return;
		return store.setDependencies(
			op,
			(op.depends_on ?? []).filter((id) => id !== from)
		);
	}
</script>

<OpGraph
	class="h-full min-h-80 rounded-lg border border-border"
	{nodes}
	{edges}
	{editable}
	{selected}
	onselect={select}
	onconnect={connect}
	ondisconnect={disconnect}
>
	{#snippet nodeActions(node)}
		<Button size="xs" variant="outline" onclick={() => onopen(node.id)}>OPEN</Button>
	{/snippet}
</OpGraph>
