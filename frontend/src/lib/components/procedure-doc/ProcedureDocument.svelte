<script lang="ts">
	// A procedure as a document: OP cards in order, contingency OPs after a
	// divider. The host supplies a controller (state + actions); this component
	// only lays the document out.
	import { EmptyLine } from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { provideDoc, type DocController } from './controller.js';
	import OpCard from './OpCard.svelte';
	import type { DocOp } from './types.js';

	let {
		controller,
		ops,
		contingency = []
	}: { controller: DocController; ops: DocOp[]; contingency?: DocOp[] } = $props();

	// svelte-ignore state_referenced_locally
	provideDoc(controller);
	const au = $derived(controller.mode === 'author' ? controller.author : undefined);
</script>

<div class="grid grid-cols-1 gap-2" data-doc-mode={controller.mode}>
	{#each ops as op (op.order)}
		<OpCard {op} />
	{/each}
	{#if contingency.length}
		<div class="label mt-2 flex items-center gap-2">
			<span class="h-px flex-1 bg-border"></span>Contingency<span class="h-px flex-1 bg-border"
			></span>
		</div>
		{#each contingency as op (op.order)}
			<OpCard {op} />
		{/each}
	{/if}
	{#if !ops.length && !contingency.length && !au}
		<EmptyLine label="Operations" />
	{/if}
	{#if au}
		<div class="flex flex-wrap items-center gap-2">
			<Button size="sm" variant="outline" onclick={() => au.addOp()}>+ OP</Button>
			<Button size="sm" variant="ghost" onclick={() => au.addOp({ contingency: true })}
				>+ CONTINGENCY OP</Button
			>
			{#if !ops.length && !contingency.length}
				<span class="font-mono text-xs text-muted-foreground">OPERATIONS — none</span>
			{/if}
		</div>
	{/if}
</div>
