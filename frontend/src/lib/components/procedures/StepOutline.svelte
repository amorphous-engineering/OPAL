<script lang="ts">
	// ---------------------------------------------------------------------------
	// REPLACEABLE: read-only outline of a procedure's steps.
	//
	// The step-authoring editor (ops/sub-steps document, step editing, images,
	// step kits, data schemas, dependencies) replaces this component wholesale.
	// Contract kept by the host page (`/procedures/[id]`): the page passes the
	// procedure's step tree as returned by GET /api/procedures/{id} and calls
	// `onchange` after any mutation so the page reloads. Nothing else on the
	// page depends on the inside of this file.
	// ---------------------------------------------------------------------------
	import { EmptyLine, Section } from '#lib/components/opal/index.js';
	import { duration } from '#lib/format.js';
	import type { StepNode } from './types.js';

	// eslint-disable-next-line svelte/no-unused-props
	let {
		steps
	}: {
		steps: StepNode[];
		onchange?: () => void | Promise<void>;
	} = $props();

	const ops = $derived(steps.filter((s) => !s.is_contingency));
	const contingency = $derived(steps.filter((s) => s.is_contingency));
	const subCount = $derived(steps.reduce((n, s) => n + s.sub_steps.length, 0));
</script>

{#snippet block(list: StepNode[], prefix: string)}
	{#each list as op (op.id)}
		<tr class="border-b border-border bg-muted/30">
			<td class="w-20 px-3 py-1.5 font-mono font-medium whitespace-nowrap"
				>{prefix}{op.step_number}</td
			>
			<td class="px-3 py-1.5 font-medium">{op.title}</td>
			<td class="w-24 px-3 py-1.5 text-right font-mono text-xs text-muted-foreground">
				{op.sub_steps.length}
				{op.sub_steps.length === 1 ? 'step' : 'steps'}
			</td>
			<td class="w-20 px-3 py-1.5 text-right font-mono text-xs text-muted-foreground">
				{op.estimated_duration_minutes ? duration(op.estimated_duration_minutes) : '—'}
			</td>
		</tr>
		{#each op.sub_steps as sub (sub.id)}
			<tr class="border-b border-border">
				<td class="px-3 py-1 pl-6 font-mono text-xs whitespace-nowrap text-muted-foreground"
					>{sub.step_number}</td
				>
				<td class="px-3 py-1">{sub.title}</td>
				<td class="px-3 py-1 text-right font-mono text-xs text-muted-foreground uppercase">
					{#if sub.signoffs?.length}{sub.signoffs.map((x) => x.label).join(' · ')}{/if}
				</td>
				<td class="px-3 py-1 text-right font-mono text-xs text-muted-foreground">
					{sub.estimated_duration_minutes ? duration(sub.estimated_duration_minutes) : '—'}
				</td>
			</tr>
		{/each}
	{/each}
{/snippet}

{#if steps.length === 0}
	<EmptyLine label="Operations" />
{:else}
	<Section title="Operations" count={`${ops.length} OPS · ${subCount} STEPS`}>
		<table class="w-full border-collapse text-sm">
			<thead>
				<tr class="border-b border-border bg-muted/60">
					<th class="label h-7 px-3 text-left font-medium">#</th>
					<th class="label h-7 px-3 text-left font-medium">Title</th>
					<th class="label h-7 px-3 text-right font-medium">Steps</th>
					<th class="label h-7 px-3 text-right font-medium">Est.</th>
				</tr>
			</thead>
			<tbody>
				{@render block(ops, 'OP ')}
				{#if contingency.length}
					<tr class="border-b border-border">
						<td colspan="4" class="label px-3 py-1">Contingency</td>
					</tr>
					{@render block(contingency, 'OP ')}
				{/if}
			</tbody>
		</table>
	</Section>
{/if}
