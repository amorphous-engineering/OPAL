<script lang="ts">
	// Read-only render of a published snapshot's operations: every instruction,
	// callouts, data field, image and step kit exactly as frozen at publish.
	import { EmptyLine, Section } from '#lib/components/opal/index.js';
	import { duration, qty } from '#lib/format.js';
	import { CalloutList, calloutsOf } from '#lib/components/procedure-doc/index.js';
	import Prose from './Prose.svelte';
	import { groupOps, type OpGroup, type SnapshotStep } from './types.js';

	let { steps }: { steps: SnapshotStep[] } = $props();

	const grouped = $derived(groupOps(steps));
</script>

{#snippet detail(s: SnapshotStep)}
	{#if calloutsOf(s).length}
		<div class="my-1"><CalloutList callouts={calloutsOf(s)} /></div>
	{/if}
	{#if s.instructions}
		<Prose source={s.instructions} class="my-1" />
	{/if}
	{#if s.images?.length}
		<div class="my-1 flex flex-wrap gap-2">
			{#each s.images as img (img.attachment_id)}
				<figure class="m-0">
					<img
						src={`/api/attachments/${img.attachment_id}/download`}
						alt={img.caption ?? ''}
						loading="lazy"
						class="max-h-40 rounded-md border border-border"
					/>
					{#if img.caption}<figcaption class="mt-0.5 text-xs text-muted-foreground">
							{img.caption}
						</figcaption>{/if}
				</figure>
			{/each}
		</div>
	{/if}
	{#if s.required_data_schema?.fields?.length}
		<table class="my-1 w-full max-w-xl border-collapse text-xs">
			<thead>
				<tr class="border-b border-border bg-muted/60">
					<th class="label h-6 px-2 text-left">Data field</th>
					<th class="label h-6 w-20 px-2 text-left">Type</th>
					<th class="label h-6 w-24 px-2 text-left">Range</th>
					<th class="label h-6 w-20 px-2 text-left">Required</th>
				</tr>
			</thead>
			<tbody>
				{#each s.required_data_schema.fields as f (f.name)}
					<tr class="border-b border-border">
						<td class="px-2 py-0.5">{f.label ?? f.name}{f.unit ? ` (${f.unit})` : ''}</td>
						<td class="px-2 py-0.5 font-mono uppercase">{f.type ?? 'text'}</td>
						<td class="px-2 py-0.5 font-mono">
							{#if f.min !== undefined || f.max !== undefined}{f.min ?? ''} – {f.max ??
									''}{:else}—{/if}
						</td>
						<td class="px-2 py-0.5 font-mono">{f.required ? 'YES' : '—'}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}
	{#if s.step_kit?.length}
		<p class="my-1 font-mono text-xs">
			<span class="label">Step kit</span>
			{s.step_kit.map((k) => `${k.part_name} × ${qty(k.quantity_required)}`).join(' · ')}
		</p>
	{/if}
	{@render signoffs(s)}
{/snippet}

{#snippet signoffs(s: SnapshotStep)}
	{#if s.signoffs?.length}
		<div class="my-1 max-w-xl overflow-hidden rounded-lg border border-border">
			<table class="w-full font-mono text-xs" aria-label="Sign-offs">
				<tbody>
					{#each s.signoffs as so, i (i)}
						<tr class="border-b border-border last:border-b-0" data-signoff={i}>
							<td class="w-44 px-2 py-1 font-sans text-sm font-medium">{so.label}</td>
							<td class="px-2 py-1 text-muted-foreground">{so.role ?? '–'}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
{/snippet}

{#snippet group(g: OpGroup)}
	<div class="border-b border-border last:border-b-0">
		<div class="flex items-baseline gap-3 bg-muted/40 px-3 py-1.5">
			<span class="font-mono font-medium">OP {g.op.step_number}</span>
			<span class="font-medium">{g.op.title}</span>
			<span class="ml-auto flex gap-3 font-mono text-xs text-muted-foreground">
				<span>{g.subs.length} {g.subs.length === 1 ? 'step' : 'steps'}</span>
				{#if g.op.estimated_duration_minutes}<span>{duration(g.op.estimated_duration_minutes)}</span
					>{/if}
			</span>
		</div>
		<div class="px-3 pb-1">{@render detail(g.op)}</div>
		{#each g.subs as s (s.id)}
			<div class="border-t border-border px-3 py-1.5 pl-8">
				<div class="flex items-baseline gap-3">
					<span class="font-mono text-xs text-muted-foreground">{s.step_number}</span>
					<span>{s.title}</span>
					<span class="ml-auto flex gap-3 font-mono text-xs text-muted-foreground uppercase">
						{#if s.required_data_schema?.fields?.length}<span>data</span>{/if}
						{#if s.estimated_duration_minutes}<span>{duration(s.estimated_duration_minutes)}</span
							>{/if}
					</span>
				</div>
				{@render detail(s)}
			</div>
		{/each}
	</div>
{/snippet}

{#if steps.length === 0}
	<EmptyLine label="Operations" />
{:else}
	<Section
		title="Operations"
		count={`${grouped.ops.length} OPS${grouped.contingency.length ? ` + ${grouped.contingency.length} CONTINGENCY` : ''}`}
	>
		{#each grouped.ops as g (g.op.id)}{@render group(g)}{/each}
		{#each grouped.contingency as g (g.op.id)}{@render group(g)}{/each}
	</Section>
{/if}
