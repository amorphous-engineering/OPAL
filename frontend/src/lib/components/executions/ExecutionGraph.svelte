<script lang="ts">
	// The OP dependency graph of a running or finished execution: read-only, live
	// from the store. Selecting a node moves the sidebar selection; OPEN returns to
	// the document, REDLINE opens the redline dialog on an OP with an open NC.
	import { OpGraph } from '#lib/components/op-graph/index.js';
	import type { GraphEdge, GraphNode } from '#lib/components/op-graph/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { isTerminal } from '#lib/components/procedure-doc/index.js';
	import type { ExecutionStore } from '#lib/execution/store.svelte.js';

	let { store, onopen }: { store: ExecutionStore; onopen: (order: number) => void } = $props();

	const ops = $derived(store.allOps);

	const nodes = $derived<GraphNode[]>(
		ops.map((op) => {
			const flags: string[] = [];
			if (op.holds.length) flags.push('HELD');
			if (op.open_ncs.length) flags.push('NC');
			if (op.waiting_on_ops.length && !isTerminal(op.status)) flags.push('WAITING');
			return {
				id: op.order,
				number: op.number,
				title: op.title,
				kind: op.is_ad_hoc ? 'redline' : op.is_contingency ? 'contingency' : 'op',
				status: op.status,
				progress: op.progress,
				flags
			};
		})
	);

	const edges = $derived.by<GraphEdge[]>(() => {
		const known = new Set(ops.map((o) => o.order));
		const out: GraphEdge[] = [];
		for (const op of ops) {
			for (const dep of op.depends_on ?? [])
				if (known.has(dep)) out.push({ from: dep, to: op.order, kind: 'dependency' });
			const host = op.redline?.host_order;
			if (op.is_ad_hoc && host != null && known.has(host))
				out.push({ from: op.order, to: host, kind: 'redline' });
		}
		return out;
	});

	function redlinable(id: number) {
		const op = ops.find((o) => o.order === id);
		return !!op && store.active && !op.is_ad_hoc && op.open_ncs.length > 0 && op;
	}
</script>

<OpGraph
	{nodes}
	{edges}
	selected={store.focusOp}
	onselect={(id) => (store.focusOp = id)}
	class="h-[max(28rem,calc(100svh-18rem))] w-full border border-border"
>
	{#snippet nodeActions(n)}
		<Button size="xs" variant="outline" onclick={() => onopen(n.id)}>OPEN</Button>
		{@const op = redlinable(n.id)}
		{#if op}
			<Button
				size="xs"
				variant="outline"
				onclick={() => (store.dialog = { kind: 'redline', op, issueId: op.open_ncs[0].id })}
				>REDLINE</Button
			>
		{/if}
	{/snippet}
</OpGraph>
