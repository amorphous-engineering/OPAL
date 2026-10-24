<script lang="ts">
	// Printable traveler: the published snapshot with write-in lines for the floor.
	import { page } from '$app/state';
	import { datetime, qty } from '#lib/format.js';
	import Prose from '#lib/components/procedures/Prose.svelte';
	import { groupOps, type DataField, type SnapshotStep } from '#lib/components/procedures/types.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const v = $derived(data.version);
	const grouped = $derived(groupOps(v.snapshot.steps));
	const partById = $derived(new Map(v.parts.map((p) => [p.id, p])));
	const target = $derived(`${page.url.origin}/procedures/versions/${v.id}`);
	const qr = $derived(`/api/procedures/versions/${v.id}/qr?url=${encodeURIComponent(target)}`);
	const hasOps = $derived(grouped.ops.length > 0);
</script>

<svelte:head><title>Traveler — {v.procedureName} v{v.versionNumber} · OPAL</title></svelte:head>

{#snippet fieldLine(f: DataField)}
	<div class="flex items-baseline gap-2 text-[10pt]">
		<span class="min-w-32 font-bold uppercase">{f.label ?? f.name}{f.required ? ' *' : ''}</span>
		{#if f.type === 'checkbox'}
			<span class="inline-block size-4 border-2 border-black"></span>
			<span class="text-[9pt]">YES / NO</span>
		{:else if f.type === 'select' && f.options?.length}
			<span class="flex flex-1 flex-wrap gap-x-4 gap-y-1">
				{#each f.options as o (o)}
					<span class="inline-flex items-center gap-1.5">
						<span class="inline-block size-4 border-2 border-black"></span>
						<span>{o}</span>
					</span>
				{/each}
			</span>
		{:else}
			<span class="min-h-[18px] flex-1 border-b border-black">&nbsp;</span>
			{#if f.unit}<span class="text-[9pt]">{f.unit}</span>{/if}
			{#if f.min !== undefined || f.max !== undefined}
				<span class="text-[9pt]">({f.min ?? ''} – {f.max ?? ''})</span>
			{/if}
		{/if}
	</div>
{/snippet}

{#snippet signLines(s: SnapshotStep)}
	{#if s.signoffs.length}
		<div class="mt-2 border-t border-neutral-400 pt-1.5 text-[9pt]">
			{#each s.signoffs as so, i (i)}
				<div class="flex items-baseline gap-4 py-1" data-signoff={i}>
					<b class="w-40 shrink-0">{so.label}</b>
					<span class="w-24 shrink-0">{so.role ?? ''}</span>
					<span class="flex flex-1 items-baseline gap-1"
						>Signed <span class="inline-block min-w-40 flex-1 border-b border-black">&nbsp;</span
						></span
					>
					<span class="flex items-baseline gap-1"
						>Date <span class="inline-block min-w-28 border-b border-black">&nbsp;</span></span
					>
				</div>
			{/each}
		</div>
	{/if}
{/snippet}

{#snippet body(s: SnapshotStep)}
	{#each s.callouts as c, i (i)}
		<p
			class={[
				'my-1 border-black px-2 py-1 text-[10pt]',
				c.kind === 'caution' ? 'border-2' : 'border'
			]}
		>
			<b>{c.kind === 'caution' ? 'CAUTION' : 'INFO'}</b>
			{c.text}
		</p>
	{/each}
	{#if s.instructions}
		<Prose source={s.instructions} class="my-1 text-[10pt]" />
	{/if}
	{#each s.images as img, i (i)}
		<figure class="my-1">
			<img
				src={`/api/blobs/${img.sha256}`}
				alt={img.caption ?? ''}
				class="max-h-48 border border-black"
			/>
			{#if img.caption}<figcaption class="text-[9pt]">{img.caption}</figcaption>{/if}
		</figure>
	{/each}
	{#if s.kit.length}
		<p class="my-1 text-[9pt]">
			<b>PARTS</b>
			{s.kit.map((k) => `${partById.get(k.partId)?.name ?? '—'} × ${qty(k.quantity)}`).join(' · ')}
		</p>
	{/if}
	<div class="grid gap-1.5">
		{#each s.dataSchema?.fields ?? [] as f (f.name)}{@render fieldLine(f)}{/each}
	</div>
{/snippet}

{#snippet opBlock(g: { op: SnapshotStep; subs: SnapshotStep[] }, contingency: boolean)}
	<section class="mb-3 break-inside-avoid-page border border-black">
		<div
			class="flex items-center gap-2 border-b border-black bg-neutral-200 px-2.5 py-1.5 font-bold"
		>
			{#if contingency}<span class="border-2 border-black bg-white px-1.5 text-[9pt]">C</span>{/if}
			<span class="text-[13pt]">OP {g.op.number}</span>
			<span>{g.op.title}</span>
			{#if g.op.estimatedDurationMinutes}
				<span class="ml-auto text-[9pt] font-normal">EST {g.op.estimatedDurationMinutes} min</span>
			{/if}
		</div>
		<div class="px-2.5 py-2">
			{@render body(g.op)}
			{#if g.subs.length === 0}{@render signLines(g.op)}{/if}
		</div>
		{#each g.subs as s (s.id)}
			<div class="break-inside-avoid border-t border-black px-2.5 py-2 pl-6">
				<div class="flex items-baseline gap-2 font-bold">
					<span>{s.number}</span>
					<span>{s.title}</span>
					{#if s.estimatedDurationMinutes}
						<span class="ml-auto text-[9pt] font-normal">EST {s.estimatedDurationMinutes} min</span>
					{/if}
				</div>
				{@render body(s)}
				{@render signLines(s)}
			</div>
		{/each}
		{#if g.subs.length > 0}
			<div class="border-t border-black px-2.5 pb-1">{@render signLines(g.op)}</div>
		{/if}
	</section>
{/snippet}

<div
	class="flex items-center gap-3 border-b border-neutral-300 bg-neutral-100 px-4 py-2 text-xs print:hidden"
>
	<a href={`/procedures/versions/${v.id}`} class="text-blue-700 underline">← v{v.versionNumber}</a>
	<button
		type="button"
		class="ml-auto border border-black bg-black px-3 py-1 font-mono text-xs font-medium text-white"
		onclick={() => window.print()}>PRINT</button
	>
</div>

<main
	class="mx-auto max-w-[8.5in] p-[0.5in] font-mono text-[11pt] leading-snug print:max-w-none print:p-0"
>
	<header class="mb-4 flex items-start justify-between border-b-[3px] border-black pb-3">
		<div>
			<h1 class="mb-1 text-[16pt] font-bold">{v.procedureName}</h1>
			<table class="text-[9pt]">
				<tbody>
					<tr>
						<td class="pr-2 font-bold uppercase">Version</td>
						<td class="pr-6">v{v.versionNumber}</td>
						<td class="pr-2 font-bold uppercase">Published</td>
						<td>{datetime(v.createdAt)}</td>
					</tr>
					<tr>
						<td class="pt-1.5 pr-2 font-bold uppercase">Work order</td>
						<td class="pt-1.5 pr-6"
							><span class="inline-block min-w-44 border-b border-black">&nbsp;</span></td
						>
						<td class="pt-1.5 pr-2 font-bold uppercase">Date</td>
						<td class="pt-1.5"
							><span class="inline-block min-w-32 border-b border-black">&nbsp;</span></td
						>
					</tr>
				</tbody>
			</table>
		</div>
		<div class="text-right">
			<img src={qr} alt={`QR code for ${target}`} class="size-20" />
			<div class="mt-1 text-[8pt]">OPAL TRAVELER</div>
		</div>
	</header>

	{#if v.snapshot.procedure.description}
		<Prose source={v.snapshot.procedure.description} class="mb-3 text-[10pt]" />
	{/if}

	{#if v.snapshot.kit.length}
		<h2 class="mt-5 mb-2 border-b-2 border-black pb-1 text-[12pt] font-bold uppercase">
			Kit / bill of materials
		</h2>
		<table class="mb-4 w-full border-collapse text-[10pt]">
			<thead>
				<tr class="bg-neutral-200 text-[9pt] uppercase">
					<th class="w-12 border border-black p-1 text-center">Kit</th>
					<th class="border border-black p-1 text-left">Part</th>
					<th class="w-32 border border-black p-1 text-left">Part no.</th>
					<th class="w-24 border border-black p-1 text-right">Qty</th>
				</tr>
			</thead>
			<tbody>
				{#each v.snapshot.kit as k (k.partId)}
					<tr>
						<td class="border border-black p-1 text-center"
							><span class="inline-block size-4 border-2 border-black align-middle"></span></td
						>
						<td class="border border-black p-1">{partById.get(k.partId)?.name ?? '—'}</td>
						<td class="border border-black p-1">{partById.get(k.partId)?.internalPn ?? '—'}</td>
						<td class="border border-black p-1 text-right">{qty(k.quantity)}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}

	<h2 class="mt-5 mb-2 border-b-2 border-black pb-1 text-[12pt] font-bold uppercase">Operations</h2>
	{#each grouped.ops as g (g.op.id)}{@render opBlock(g, false)}{/each}
	{#if !hasOps}<p class="mb-3 text-[10pt]">OPERATIONS — none</p>{/if}

	{#if grouped.contingency.length}
		<h2 class="mt-5 mb-2 border-b-2 border-black pb-1 text-[12pt] font-bold uppercase">
			Contingency operations
		</h2>
		{#each grouped.contingency as g (g.op.id)}{@render opBlock(g, true)}{/each}
	{/if}

	<footer class="mt-8 flex break-inside-avoid justify-between border-t-[3px] border-black pt-4">
		{#each ['Operator', 'Inspector', 'Date'] as label (label)}
			<div class="min-w-48 text-center">
				<div class="mb-1 h-10 border-b border-black"></div>
				<div class="text-[9pt] font-bold uppercase">{label}</div>
			</div>
		{/each}
	</footer>
</main>

<style>
	@media print {
		@page {
			margin: 0.5in;
		}
	}
</style>
