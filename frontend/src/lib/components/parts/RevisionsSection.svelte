<script lang="ts">
	// Which part this one revises and which parts revise it, with why. A reader of an old part
	// sees that the design moved on, on the page itself.
	import { DetailRow, DetailTable, Section, State, Timestamp } from '#lib/components/opal/index.js';
	import type { PartDetail, PartRevisionRef } from '@opal/shared';

	let { detail }: { detail: PartDetail } = $props();
	const count = $derived((detail.revises ? 1 : 0) + detail.revisedBy.length);
</script>

{#snippet row(label: string, r: PartRevisionRef)}
	<DetailRow {label} mono>
		<a href={`/parts/${r.partId}`} class="text-info hover:underline">{r.internalPn}</a>
		{#if r.state === 'draft'}<State value="draft" tone="warn" badge class="ml-2" />{/if}
		<p class="font-sans text-sm">{r.reason}</p>
		<p class="font-sans text-xs text-muted-foreground">
			{r.createdBy ?? 'Unknown'}, <Timestamp value={r.createdAt} />
		</p>
	</DetailRow>
{/snippet}

{#if count}
	<Section title="Revisions" {count}>
		<DetailTable>
			{#if detail.revises}{@render row('Revises', detail.revises)}{/if}
			{#each detail.revisedBy as r (r.partId)}{@render row('Revised by', r)}{/each}
		</DetailTable>
	</Section>
{/if}
