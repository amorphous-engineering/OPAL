<script lang="ts">
	// Read-only render of a published snapshot's operations: every instruction,
	// callouts, data field, image and step kit exactly as frozen at publish. A short document
	// opens fully; a long one opens as its list of operations. An OP opens with a click.
	import CaretRight from 'phosphor-svelte/lib/CaretRight';
	import { tick } from 'svelte';
	import { cn } from '#lib/utils.js';
	import { EmptyLine, Section } from '#lib/components/opal/index.js';
	import { duration, qty } from '#lib/format.js';
	import { CalloutList } from '#lib/components/procedure-doc/index.js';
	import { specText, unitSymbol } from '@opal/shared';
	import Prose from './Prose.svelte';
	import type { VersionPart } from '@opal/shared';
	import { groupOps, type OpGroup, type SnapshotStep } from './types.js';

	let { steps, parts }: { steps: SnapshotStep[]; parts: VersionPart[] } = $props();

	const partById = $derived(new Map(parts.map((p) => [p.id, p])));

	const grouped = $derived(groupOps(steps));

	// Same threshold the editor uses to open a document fully.
	const SMALL_DOC = 12;
	let overrides = $state<Record<number, boolean>>({});
	const isOpen = (id: number) => overrides[id] ?? steps.length <= SMALL_DOC;

	export function setAll(open: boolean) {
		overrides = Object.fromEntries(
			[...grouped.ops, ...grouped.contingency].map((g) => [g.op.id, open])
		);
	}

	/** Open one OP and bring it into view. */
	export async function reveal(opId: number) {
		overrides[opId] = true;
		await tick();
		document.getElementById(`op-${opId}`)?.scrollIntoView({ block: 'start' });
	}
</script>

{#snippet detail(s: SnapshotStep)}
	{#if s.callouts.length}
		<div class="my-1"><CalloutList callouts={s.callouts} /></div>
	{/if}
	{#if s.instructions}
		<Prose source={s.instructions} class="my-1" />
	{/if}
	{#if s.images.length}
		<div class="my-1 flex flex-wrap gap-2">
			{#each s.images as img, i (i)}
				<figure class="m-0">
					<img
						src={`/api/blobs/${img.sha256}`}
						alt={img.caption ?? ''}
						loading="lazy"
						class="max-h-40 border border-border"
					/>
					{#if img.caption}<figcaption class="mt-0.5 text-xs text-muted-foreground">
							{img.caption}
						</figcaption>{/if}
				</figure>
			{/each}
		</div>
	{/if}
	{#if s.dataSchema?.fields?.length}
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
				{#each s.dataSchema.fields as f (f.name)}
					<tr class="border-b border-border">
						<td class="px-2 py-0.5"
							>{f.label ?? f.name}{f.unit ? ` (${unitSymbol(f.unit)})` : ''}</td
						>
						<td class="px-2 py-0.5 font-mono uppercase">{f.type ?? 'text'}</td>
						<td class="px-2 py-0.5 font-mono">
							{#if f.spec}{specText(
									f.spec,
									f.unit
								)}{:else if f.min !== undefined || f.max !== undefined}{f.min ?? ''} – {f.max ??
									''}{:else}—{/if}
						</td>
						<td class="px-2 py-0.5 font-mono">{f.required ? 'YES' : '—'}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}
	{#if s.kit.length}
		<p class="my-1 font-mono text-xs">
			<span class="label">Step kit</span>
			{s.kit.map((k) => `${partById.get(k.partId)?.name ?? '—'} × ${qty(k.quantity)}`).join(' · ')}
		</p>
	{/if}
	{@render signoffs(s)}
{/snippet}

{#snippet signoffs(s: SnapshotStep)}
	{#if s.signoffs.length}
		<div class="my-1 max-w-xl overflow-hidden border border-border">
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
	{@const open = isOpen(g.op.id)}
	<div id={`op-${g.op.id}`} class="scroll-mt-2 border-b border-border last:border-b-0">
		<button
			type="button"
			class="flex w-full cursor-pointer items-baseline gap-3 bg-muted/40 px-3 py-1.5 text-left hover:bg-accent"
			aria-expanded={open}
			onclick={() => (overrides[g.op.id] = !open)}
		>
			<CaretRight
				weight="bold"
				class={cn('size-3 shrink-0 translate-y-0.5 text-muted-foreground', open && 'rotate-90')}
				aria-hidden="true"
			/>
			<span class="font-mono font-medium">OP {g.op.number}</span>
			<span class="font-medium">{g.op.title}</span>
			<span class="ml-auto flex gap-3 font-mono text-xs text-muted-foreground">
				<span>{g.subs.length} {g.subs.length === 1 ? 'step' : 'steps'}</span>
				{#if g.op.estimatedDurationMinutes}<span>{duration(g.op.estimatedDurationMinutes)}</span
					>{/if}
			</span>
		</button>
		{#if open}
			<div class="px-3 pb-1">{@render detail(g.op)}</div>
		{/if}
		{#each open ? g.subs : [] as s (s.id)}
			<div class="border-t border-border px-3 py-1.5 pl-8">
				<div class="flex items-baseline gap-3">
					<span class="font-mono text-xs text-muted-foreground">{s.number}</span>
					<span>{s.title}</span>
					<span class="ml-auto flex gap-3 font-mono text-xs text-muted-foreground uppercase">
						{#if s.dataSchema?.fields?.length}<span>data</span>{/if}
						{#if s.estimatedDurationMinutes}<span>{duration(s.estimatedDurationMinutes)}</span>{/if}
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
