<script lang="ts">
	import { stateLabel } from '#lib/format.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import ReportChart from '#lib/components/executions/ReportChart.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const r = $derived(data.report);

	/** ISO 8601, UTC, to the second. */
	const ts = (v: string | null | undefined) =>
		v
			? new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(v) ? v : `${v}Z`).toISOString().slice(0, 19) + 'Z'
			: '—';
	const dash = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : String(v));
	const origin = typeof window === 'undefined' ? '' : window.location.origin;
</script>

<svelte:head>
	<title>Build report {r?.instance.work_order ?? `#${data.id}`} · OPAL</title>
</svelte:head>

<div class="report min-h-svh bg-white p-8 font-mono text-[11pt] leading-snug text-black">
	{#if !r}
		<h1 class="text-base font-bold uppercase">Build report unavailable</h1>
		<p class="mt-2">{data.problem}</p>
		<p class="mt-2"><a class="underline" href={`/executions/${data.id}`}>Back to execution</a></p>
	{:else}
		<div class="mb-4 flex justify-end gap-2 print:hidden">
			<Button size="sm" variant="outline" href={`/executions/${r.instance.id}`}
				>BACK TO EXECUTION</Button
			>
			<Button size="sm" onclick={() => window.print()}>PRINT</Button>
		</div>

		<header class="flex items-start justify-between border-b-[3px] border-black pb-3">
			<div>
				<h1 class="mb-1 text-[16pt] font-bold uppercase">Build report</h1>
				<table class="text-[9pt]">
					<tbody>
						<tr>
							<th class="pr-2 text-left font-bold uppercase">Work order</th>
							<td class="pr-6">{r.instance.work_order ?? `#${r.instance.id}`}</td>
							<th class="pr-2 text-left font-bold uppercase">Status</th>
							<td>{stateLabel(r.instance.status)}</td>
						</tr>
						<tr>
							<th class="pr-2 text-left font-bold uppercase">Procedure</th>
							<td class="pr-6">{r.instance.procedure_name ?? '—'} v{r.instance.version_number}</td>
							<th class="pr-2 text-left font-bold uppercase">Started</th>
							<td>{ts(r.instance.started_at)}</td>
						</tr>
						<tr>
							<th class="pr-2 text-left font-bold uppercase">Operator</th>
							<td class="pr-6">{dash(r.instance.operator)}</td>
							<th class="pr-2 text-left font-bold uppercase">Completed</th>
							<td>{ts(r.instance.completed_at)}</td>
						</tr>
						<tr>
							<th class="pr-2 text-left font-bold uppercase">Generated</th>
							<td colspan="3">{ts(r.generated_at)}</td>
						</tr>
					</tbody>
				</table>
			</div>
			<div class="text-right">
				<img
					src={`/api/procedure-instances/${r.instance.id}/qr.svg?origin=${encodeURIComponent(origin)}`}
					alt="QR code to the execution"
					class="size-20"
				/>
				<div class="mt-1 text-[8pt]">OPAL BUILD REPORT</div>
			</div>
		</header>

		{#snippet h2(text: string)}
			<h2 class="mt-5 mb-2 border-b-2 border-black pb-1 text-[12pt] font-bold uppercase">{text}</h2>
		{/snippet}
		{#snippet none(text: string)}
			<p class="py-1 text-[10pt] text-neutral-600">{text} — none</p>
		{/snippet}

		{@render h2('End item')}
		{#if r.end_items.length}
			<table class="dense">
				<thead
					><tr
						><th>Part</th><th>Internal PN</th><th>OPAL #</th><th>Serial</th><th>Qty</th><th
							>Status</th
						></tr
					></thead
				>
				<tbody>
					{#each r.end_items as e, i (i)}
						<tr>
							<td>{e.part_name}</td><td>{dash(e.part_number)}</td><td>{dash(e.opal_number)}</td><td
								>{dash(e.serial_number)}</td
							>
							<td class="text-right">{e.quantity}</td><td>{stateLabel(e.status)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		{:else}{@render none('End item')}{/if}

		{@render h2('Operations summary')}
		{#if r.operations.length}
			<table class="dense">
				<thead
					><tr
						><th>Step</th><th>Title</th><th>Status</th><th>Started</th><th>Completed</th><th
							>Operator</th
						><th>Sign-offs</th></tr
					></thead
				>
				<tbody>
					{#each r.operations as o, i (i)}
						<tr>
							<td>{o.step_number}</td>
							<td style:padding-left={`${0.5 + o.level * 0.75}rem`}>{o.title}</td>
							<td>{stateLabel(o.status)}</td>
							<td>{ts(o.started_at)}</td><td>{ts(o.completed_at)}</td>
							<td>{dash(o.operator)}</td>
							<td>
								{#each o.signoffs as so (so.slot)}
									<div data-signoff={so.slot}>
										<b>{so.label}</b>{so.role ? ` (${so.role})` : ''}: {dash(so.signed_by)}
										<span class="whitespace-nowrap">{ts(so.signed_at)}</span>
									</div>
								{:else}—{/each}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		{:else}{@render none('Operations')}{/if}

		{@render h2('Data collects')}
		{#if r.data_collects.length}
			{#each r.data_collects as dc (dc.step_number)}
				<div class="mb-3 [break-inside:avoid] border border-black">
					<div class="flex gap-2 border-b border-black bg-neutral-200 px-2 py-1 font-bold">
						<span>{dc.step_number}</span><span>{dc.step_title}</span>
					</div>
					<table class="dense inner">
						<thead
							><tr><th class="w-2/5">Field</th><th>Value</th><th class="w-20">Unit</th></tr></thead
						>
						<tbody>
							{#each dc.rows as row, i (i)}
								<tr><td>{row.label}</td><td>{row.value}</td><td>{dash(row.unit)}</td></tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/each}
		{:else}{@render none('Data collects')}{/if}

		{@render h2('Dataset charts')}
		{#if r.chart_datasets.length}
			{#each r.chart_datasets as ds (ds.dataset_id)}
				{#each ds.chart_fields as f (f.name)}
					<div class="mb-4 [break-inside:avoid] border border-black p-2">
						<h3 class="mb-1 text-[10pt] font-bold uppercase">
							{ds.name} - {f.label ?? f.name}{f.unit ? ` (${f.unit})` : ''}
						</h3>
						<ReportChart
							points={ds.points}
							field={f.name}
							label={`${ds.name} ${f.label ?? f.name}`}
						/>
						<table class="dense mt-2">
							<thead>
								<tr>
									<th>Recorded</th>
									{#each ds.fields as c (c.name)}<th
											>{c.label ?? c.name}{c.unit ? ` (${c.unit})` : ''}</th
										>{/each}
								</tr>
							</thead>
							<tbody>
								{#each ds.points as p, i (i)}
									<tr>
										<td>{ts(p.recorded_at)}</td>
										{#each ds.fields as c (c.name)}<td>{dash(p.values[c.name])}</td>{/each}
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{/each}
			{/each}
		{:else}{@render none('Dataset charts')}{/if}

		{@render h2('Issue tickets')}
		{#if r.issues.length}
			<table class="dense">
				<thead
					><tr
						><th>Issue #</th><th>Type</th><th>Priority</th><th>Status</th><th>Title</th><th
							>Root cause</th
						><th>Disposition</th><th>Opened</th></tr
					></thead
				>
				<tbody>
					{#each r.issues as i (i.id)}
						<tr>
							<td>{i.issue_number}</td><td>{stateLabel(i.issue_type)}</td><td
								>{stateLabel(i.priority)}</td
							><td>{stateLabel(i.status)}</td>
							<td>{i.title}</td>
							<td
								>{i.root_cause
									? i.root_cause.length > 200
										? `${i.root_cause.slice(0, 200)}...`
										: i.root_cause
									: '—'}</td
							>
							<td>{stateLabel(i.disposition_type)}</td><td>{ts(i.created_at)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		{:else}{@render none('Issue tickets')}{/if}

		{@render h2('Closeout photos')}
		{#if r.closeout_attachments.length}
			<div class="grid grid-cols-2 gap-3">
				{#each r.closeout_attachments as a (a.id)}
					<figure class="m-0 [break-inside:avoid] border border-black p-1.5">
						<img
							src={`/api/attachments/${a.id}/download`}
							alt={a.filename}
							class="mx-auto block max-h-90 max-w-full"
						/>
						<figcaption class="mt-1 text-center text-[9pt] break-all">
							{a.filename}<br />{ts(a.created_at)}
						</figcaption>
					</figure>
				{/each}
			</div>
		{:else}{@render none('Closeout photos')}{/if}

		<footer class="mt-8 flex justify-between border-t-[3px] border-black pt-4">
			{#each ['Operator', 'Inspector', 'Date'] as who (who)}
				<div class="min-w-48 text-center">
					<div class="mb-1 h-10 border-b border-black"></div>
					<div class="text-[9pt] font-bold uppercase">{who}</div>
				</div>
			{/each}
		</footer>
	{/if}
</div>

<style>
	.report :global(table.dense) {
		width: 100%;
		border-collapse: collapse;
		font-size: 10pt;
		margin-bottom: 0.75rem;
	}
	.report :global(table.dense th),
	.report :global(table.dense td) {
		border: 1px solid #000;
		padding: 3px 6px;
		text-align: left;
		vertical-align: top;
	}
	.report :global(table.dense th) {
		background: #e5e5e5;
		font-size: 9pt;
		text-transform: uppercase;
	}
	.report :global(table.dense.inner) {
		margin-bottom: 0;
		border: 0;
	}
	.report :global(table.dense td.text-right) {
		text-align: right;
	}
	@media print {
		.report {
			padding: 0;
		}
		@page {
			margin: 0.5in;
		}
	}
</style>
