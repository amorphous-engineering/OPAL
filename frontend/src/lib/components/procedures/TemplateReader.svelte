<script lang="ts">
	// The template page for reading, in the same shape as the editor: OP index and facts on the
	// left, the document (or GRAPH, DETAILS) in the centre, the surrounding record on the right.
	// It shows what the floor works from: the released version, or the draft of a template that
	// was never published. Nothing here starts an editor or saves anything.
	import { tick } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { Button } from '#lib/components/ui/button/index.js';
	import { cn } from '#lib/utils.js';
	import { OpGraph } from '#lib/components/op-graph/index.js';
	import { TabStrip } from '#lib/components/opal/index.js';
	import SnapshotSteps from './SnapshotSteps.svelte';
	import TemplateDetails from './TemplateDetails.svelte';
	import TemplateNav from './TemplateNav.svelte';
	import TemplateSide from './TemplateSide.svelte';
	import type { TemplateData } from './template-data.js';
	import { draftAsSnapshot, groupOps, snapshotGraph } from './types.js';

	let {
		data,
		unpublished,
		startable,
		onreload
	}: {
		data: TemplateData;
		unpublished: boolean | null;
		startable: boolean;
		onreload: () => void | Promise<void>;
	} = $props();

	const source = $derived(
		data.current
			? { steps: data.current.snapshot.steps, parts: data.current.parts }
			: draftAsSnapshot(data.draftSteps ?? [])
	);
	const groups = $derived(groupOps(source.steps));
	const all = $derived([...groups.ops, ...groups.contingency]);
	const navOps = $derived(
		all.map((g) => ({ key: g.op.id, number: g.op.number, title: g.op.title, steps: g.subs.length }))
	);
	const counts = $derived({ ops: all.length, steps: all.reduce((n, g) => n + g.subs.length, 0) });
	const graph = $derived(snapshotGraph(source.steps));

	let reader = $state<ReturnType<typeof SnapshotSteps>>();
	let selected = $state<number | null>(null);

	const tabs = [
		{ id: 'document', label: 'Document' },
		{ id: 'graph', label: 'Graph' },
		{ id: 'details', label: 'Details' }
	];
	const tab = $derived(
		tabs.find((t) => t.id === page.url.searchParams.get('tab'))?.id ?? 'document'
	);

	function setTab(value: string) {
		const url = new URL(page.url.href);
		if (value === 'document') url.searchParams.delete('tab');
		else url.searchParams.set('tab', value);
		return goto(url, { replace: true, reset: false });
	}

	/** Open an OP in the document, switching to the document tab first. */
	async function jump(id: number) {
		selected = id;
		if (tab !== 'document') {
			await setTab('document');
			await tick();
		}
		await reader?.reveal(id);
	}

	const barButton =
		'px-3 font-mono text-xs font-medium tracking-wider uppercase outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset';
</script>

<div
	class="grid min-h-0 flex-1 grid-cols-1 items-start gap-4 p-4 lg:grid-cols-[fit-content(20%)_minmax(0,1fr)_fit-content(20%)] lg:grid-rows-[minmax(0,1fr)] lg:items-stretch lg:pb-0"
>
	<aside
		class="min-w-0 overflow-x-hidden lg:h-full lg:min-h-0 lg:overflow-y-hidden lg:pb-4"
		aria-label="Operations"
	>
		<TemplateNav
			ops={navOps}
			{selected}
			{counts}
			{data}
			{unpublished}
			editing={false}
			onjump={jump}
		/>
	</aside>
	<div class="flex min-h-0 min-w-0 flex-col gap-3">
		<TabStrip {tabs} value={tab} onchange={setTab} class="shrink-0">
			{#snippet end()}
				{#if tab === 'document'}
					<button
						type="button"
						class={cn(
							barButton,
							'border-l border-border text-muted-foreground hover:text-foreground max-sm:hidden'
						)}
						onclick={() => reader?.setAll(true)}>Expand all</button
					>
					<button
						type="button"
						class={cn(
							barButton,
							'border-l border-border text-muted-foreground hover:text-foreground max-sm:hidden'
						)}
						onclick={() => reader?.setAll(false)}>Collapse all</button
					>
				{/if}
			{/snippet}
		</TabStrip>
		<div
			class={cn(
				'min-h-0 min-w-0 flex-1 lg:pb-4',
				tab === 'graph' ? 'min-h-80 lg:overflow-hidden' : 'lg:overflow-y-auto'
			)}
		>
			{#if tab === 'details'}
				<TemplateDetails {data} editing={false} onchange={onreload} />
			{:else if tab === 'graph'}
				<OpGraph
					class="h-full min-h-80 border border-border"
					nodes={graph.nodes}
					edges={graph.edges}
					editable={false}
					{selected}
					onselect={(id) => (selected = id)}
				>
					{#snippet nodeActions(node)}
						<Button size="sm" variant="outline" onclick={() => jump(node.id)}>OPEN</Button>
					{/snippet}
				</OpGraph>
			{:else}
				<SnapshotSteps bind:this={reader} steps={source.steps} parts={source.parts} />
			{/if}
		</div>
	</div>
	<aside
		class="min-w-0 overflow-x-hidden lg:h-full lg:min-h-0 lg:overflow-y-hidden lg:pb-4"
		aria-label="Executions, issues and reference documents"
	>
		<TemplateSide {data} {startable} editing={false} onchange={onreload} />
	</aside>
</div>
