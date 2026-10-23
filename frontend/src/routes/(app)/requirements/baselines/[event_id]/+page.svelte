<script lang="ts">
	import {
		DataTable,
		DetailRow,
		DetailTable,
		PageHeader,
		Section,
		State,
		Timestamp,
		type Column
	} from '#lib/components/opal/index.js';
	import { datetime } from '#lib/format.js';
	import Redline from '#lib/components/requirements/Redline.svelte';
	import { lifecycleTone } from '#lib/components/requirements/lifecycle.js';
	import type { EventItem } from '#lib/components/requirements/types.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const ev = $derived(data.event);

	const columns: Column<EventItem>[] = [
		{ key: 'req_number', label: 'Number', mono: true, width: '7rem' },
		{ key: 'revision', label: 'Rev', mono: true, width: '6rem' },
		{ key: 'title', label: 'Title', width: '16rem' },
		{ key: 'statement', label: 'Statement / change' },
		{ key: 'lifecycle_state', label: 'State now', width: '8rem' }
	];
</script>

<PageHeader
	title={ev.label ?? `Baseline ${datetime(ev.created_at)}`}
	identifier={null}
	crumbs={[
		{ label: 'Requirements', href: '/requirements' },
		{ label: 'Baselines', href: '/requirements/baselines' },
		{ label: ev.label ?? datetime(ev.created_at) }
	]}
/>

<div class="grid grid-cols-1 gap-4 p-4">
	<Section title="EVENT">
		<DetailTable>
			<DetailRow label="Label" value={ev.label} mono />
			<DetailRow label="Signed by" value={ev.signed_by} />
			<DetailRow label="When"><Timestamp value={ev.created_at} /></DetailRow>
			<DetailRow label="Note" value={ev.note} />
			<DetailRow label="Locked" value={ev.locked} mono />
			<DetailRow label="Revised" value={ev.revised} mono />
		</DetailTable>
	</Section>

	<Section title="LOCKED REVISIONS" count={ev.items.length}>
		<DataTable
			rows={ev.items}
			{columns}
			href={(i) => `/requirements/${i.id}`}
			key={(i) => i.id}
			emptyLabel="Locked revisions"
			dense
		>
			{#snippet cell(i, col)}
				{#if col.key === 'req_number'}<span class="text-info">{i.req_number}</span>
				{:else if col.key === 'revision'}
					<span class="mr-1">{i.revision}</span>
					<span class="text-muted-foreground"
						>{i.previous_revision ? `(was ${i.previous_revision})` : '(new)'}</span
					>
				{:else if col.key === 'title'}{i.title}
				{:else if col.key === 'statement'}
					{#if i.diff}
						<div class="grid grid-cols-1 gap-1">
							{#if i.changed.length}
								<span class="font-mono text-xs text-muted-foreground uppercase"
									>{i.changed.join(', ').replace(/_/g, ' ')}</span
								>
							{:else}
								<span class="font-mono text-xs text-muted-foreground uppercase"
									>no content change</span
								>
							{/if}
							{#if i.changed.includes('statement')}<Redline segments={i.diff.statement} />{:else}
								<span class="font-mono text-xs">{i.statement}</span>
							{/if}
							{#if i.changed.includes('rationale')}<Redline segments={i.diff.rationale} />{/if}
							{#if i.changed.includes('title')}<Redline segments={i.diff.title} />{/if}
						</div>
					{:else}
						<span class="font-mono text-xs">{i.statement}</span>
					{/if}
				{:else}
					<State value={i.lifecycle_state} tone={lifecycleTone(i.lifecycle_state)} />
				{/if}
			{/snippet}
		</DataTable>
	</Section>
</div>
