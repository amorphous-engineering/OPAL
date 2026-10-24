<script lang="ts">
	// Right column: recent executions, open issues and reference documents.
	import { Button } from '#lib/components/ui/button/index.js';
	import { EmptyLine, Section, State } from '#lib/components/opal/index.js';
	import { ticketLabel, ticketTone } from '#lib/components/issues/issues.js';
	import ReferenceDocs from './ReferenceDocs.svelte';
	import type { TemplateData } from './template-data.js';

	let {
		data,
		startable,
		onchange
	}: { data: TemplateData; startable: boolean; onchange: () => void | Promise<void> } = $props();

	const p = $derived(data.procedure);
	const execs = $derived(data.executions);
	const issues = $derived(data.issues);
</script>

<div class="flex min-w-0 flex-col gap-3 [overflow-wrap:anywhere] lg:h-full">
	{#if execs.total === 0}
		<EmptyLine
			label="Executions"
			addHref={startable ? `/executions/new?procedure_id=${p.id}` : undefined}
			addLabel="+ START"
		/>
	{:else}
		<Section
			class="lg:flex lg:max-h-[30%] lg:min-h-0 lg:flex-none lg:flex-col"
			title="Executions"
			count={execs.total}
		>
			{#snippet actions()}
				{#if execs.total > execs.items.length}
					<Button size="xs" variant="ghost" href={`/executions?procedure=${p.id}&status=all`}
						>ALL →</Button
					>
				{/if}
			{/snippet}
			<div class="min-h-0 overflow-x-hidden overflow-y-auto">
				<ul class="m-0 list-none p-0">
					{#each execs.items as r (r.id)}
						<li
							class="flex items-center gap-2 border-b border-border px-3 py-1 text-xs last:border-b-0"
						>
							<a
								class="font-mono font-medium text-info hover:underline"
								href={`/executions/${r.id}`}>{r.work_order_number ?? '—'}</a
							>
							<span class="font-mono text-muted-foreground">v{r.version_number}</span>
							<span class="ml-auto"><State value={r.status} /></span>
						</li>
					{/each}
				</ul>
			</div>
		</Section>
	{/if}

	{#if issues.total === 0}
		<EmptyLine label="Open issues" />
	{:else}
		<Section
			class="lg:flex lg:min-h-0 lg:flex-[0_1_auto] lg:flex-col"
			title="Open issues"
			count={issues.total}
		>
			{#snippet actions()}
				{#if issues.total > issues.items.length}
					<Button size="xs" variant="ghost" href={`/issues?procedure=${p.id}&status=open`}
						>ALL →</Button
					>
				{/if}
			{/snippet}
			<div class="min-h-0 overflow-x-hidden overflow-y-auto">
				<ul class="m-0 list-none p-0">
					{#each issues.items as i (i.id)}
						<li class="border-b border-border px-3 py-1.5 text-xs last:border-b-0">
							<div class="flex items-center gap-2">
								<a class="font-mono font-medium text-info hover:underline" href={`/issues/${i.id}`}
									>{i.issue_number ?? '—'}</a
								>
								<span class="ml-auto"
									><State
										value={i.ticket_state}
										tone={ticketTone(i.ticket_state)}
										label={ticketLabel(i.ticket_state)}
										badge
									/></span
								>
							</div>
							<div class="truncate text-muted-foreground" title={i.title}>{i.title}</div>
						</li>
					{/each}
				</ul>
			</div>
		</Section>
	{/if}

	<ReferenceDocs procedureId={p.id} docs={data.docs} {onchange} compact />
</div>
