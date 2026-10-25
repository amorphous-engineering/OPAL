<script lang="ts">
	import { Button } from '#lib/components/ui/button/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import {
		DataTable,
		DetailRow,
		DetailTable,
		EmptyLine,
		PageHeader,
		Section,
		State,
		Timestamp
	} from '#lib/components/opal/index.js';
	import type { Column, Tone } from '#lib/components/opal/index.js';
	import { qty } from '#lib/format.js';
	import type { PartDiff, StepDiff } from '#lib/components/procedures/types.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const d = $derived(data.diff);
	const a = $derived(d.versionA);
	const b = $derived(d.versionB);
	let showUnchanged = $state(false);

	const FIELD_LABELS: Record<string, string> = {
		title: 'title',
		instructions: 'instructions',
		isContingency: 'contingency',
		estimatedDurationMinutes: 'duration (min)',
		workcenterId: 'workcenter',
		callouts: 'callouts',
		dataSchema: 'data fields',
		signoffs: 'sign-offs',
		strictSequence: 'strict sequence',
		dependsOn: 'dependencies',
		kit: 'step kit',
		images: 'images',
		name: 'name',
		description: 'description',
		procedureType: 'type'
	};

	const TONES: Record<string, Tone> = {
		added: 'ok',
		removed: 'error',
		modified: 'warn',
		unchanged: 'muted'
	};

	function brief(v: unknown): string {
		if (v === null || v === undefined || v === '') return '—';
		if (typeof v === 'boolean') return v ? 'yes' : 'no';
		return String(v);
	}

	/** "duration: 5 → 10" for short scalars; just the field name for long or structured values. */
	function signoffList(v: unknown): string {
		if (!Array.isArray(v) || v.length === 0) return 'none';
		return v
			.map((x: { label: string; role: string | null }) =>
				x.role ? `${x.label} (${x.role})` : x.label
			)
			.join(', ');
	}

	function calloutList(v: unknown): string {
		if (!Array.isArray(v) || v.length === 0) return 'none';
		return v
			.map((x: { kind: string; text: string }) => `${x.kind.toUpperCase()}: ${x.text}`)
			.join(' | ');
	}

	function describe(field: string, ch: { a: unknown; b: unknown }): string {
		const label = FIELD_LABELS[field] ?? field;
		if (field === 'signoffs') return `${label}: ${signoffList(ch.a)} → ${signoffList(ch.b)}`;
		if (field === 'callouts') return `${label}: ${calloutList(ch.a)} → ${calloutList(ch.b)}`;
		const simple = (v: unknown) =>
			v === null ||
			v === undefined ||
			['boolean', 'number'].includes(typeof v) ||
			(typeof v === 'string' && v.length <= 40);
		return simple(ch.a) && simple(ch.b) ? `${label}: ${brief(ch.a)} → ${brief(ch.b)}` : label;
	}

	const visibleSteps = $derived(
		showUnchanged ? d.steps : d.steps.filter((s) => s.status !== 'unchanged')
	);

	const stepColumns: Column<StepDiff>[] = [
		{ key: 'number', label: '#', width: '5rem', mono: true },
		{ key: 'status', label: 'Change', width: '7rem' },
		{ key: 'titleA', label: 'From' },
		{ key: 'titleB', label: 'To' },
		{ key: 'changedFields', label: 'Changed' }
	];
	const partColumns = $derived<Column<PartDiff>[]>([
		{ key: 'internalPn', label: 'PN', width: '9rem', mono: true },
		{ key: 'name', label: 'Name' },
		{ key: 'status', label: 'Change', width: '7rem' },
		{ key: 'quantityA', label: `v${a.versionNumber}`, align: 'right', width: '7rem', mono: true },
		{ key: 'quantityB', label: `v${b.versionNumber}`, align: 'right', width: '7rem', mono: true }
	]);
	const procColumns = $derived<Column<(typeof d.procedureChanges)[number]>[]>([
		{ key: 'field', label: 'Field', width: '10rem' },
		{ key: 'a', label: `v${a.versionNumber}` },
		{ key: 'b', label: `v${b.versionNumber}` }
	]);
</script>

{#snippet partDiff(title: string, rows: PartDiff[])}
	{#if rows.length === 0}
		<EmptyLine label={`${title} changes`} />
	{:else}
		<Section {title} count={rows.length}>
			<DataTable {rows} columns={partColumns} emptyLabel={title} dense key={(r) => r.partId}>
				{#snippet cell(r, col)}
					{#if col.key === 'internalPn'}
						<a href={`/parts/${r.partId}`} class="text-info hover:underline"
							>{r.internalPn ?? '—'}</a
						>
					{:else if col.key === 'name'}
						{r.name ?? '—'}
					{:else if col.key === 'status'}
						<State value={r.status} tone={TONES[r.status]} />
					{:else if col.key === 'quantityA'}
						{qty(r.quantityA)}
					{:else if col.key === 'quantityB'}
						{qty(r.quantityB)}
					{/if}
				{/snippet}
			</DataTable>
		</Section>
	{/if}
{/snippet}

<PageHeader
	title={d.procedureName}
	identifier={`v${a.versionNumber} → v${b.versionNumber}`}
	crumbs={[
		{ label: 'Templates', href: '/procedures' },
		{ label: d.procedureName, href: `/procedures/${d.procedureId}` },
		{ label: 'Diff' }
	]}
>
	{#snippet actions()}
		<Button variant="outline" href={`/procedures/${d.procedureId}/versions/${b.id}/diff/${a.id}`}
			>SWAP</Button
		>
		<Button variant="outline" href={`/procedures/${d.procedureId}`}>TEMPLATE</Button>
	{/snippet}
</PageHeader>

<div class="grid grid-cols-1 items-start gap-4 p-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
	<div class="grid min-w-0 grid-cols-1 gap-4">
		<Section
			title="Steps"
			count={`${d.added} ADDED · ${d.removed} REMOVED · ${d.modified} MODIFIED`}
		>
			{#snippet actions()}
				<div class="flex items-center gap-2">
					<Checkbox id="show-unchanged" bind:checked={showUnchanged} />
					<Label for="show-unchanged" class="font-mono text-xs uppercase"
						>Unchanged ({d.unchanged})</Label
					>
				</div>
			{/snippet}
			<DataTable
				rows={visibleSteps}
				columns={stepColumns}
				emptyLabel="Step changes"
				dense
				key={(r) => r.number}
			>
				{#snippet cell(r, col)}
					{#if col.key === 'status'}
						<State value={r.status} tone={TONES[r.status]} />
					{:else if col.key === 'titleA'}
						<span class={r.status === 'removed' ? 'text-error' : ''}>{r.titleA ?? '—'}</span>
					{:else if col.key === 'titleB'}
						<span class={r.status === 'added' ? 'text-ok' : ''}>{r.titleB ?? '—'}</span>
					{:else if col.key === 'changedFields'}
						{#if r.changedFields.length}
							<ul class="grid grid-cols-1 gap-0.5 font-mono text-xs">
								{#each r.changedFields as f (f)}<li>{describe(f, r.changes[f])}</li>{/each}
							</ul>
						{:else}<span class="text-muted-foreground">—</span>{/if}
					{:else}
						{r.number}
					{/if}
				{/snippet}
			</DataTable>
		</Section>
		{@render partDiff('Kit', d.kit)}
		{@render partDiff('Outputs', d.outputs)}
	</div>

	<div class="grid min-w-0 grid-cols-1 gap-4">
		<Section title="Versions">
			<DetailTable>
				<DetailRow label={`v${a.versionNumber}`}>
					<a href={`/procedures/versions/${a.id}`} class="text-info hover:underline">View</a>
					· <Timestamp value={a.createdAt} />
				</DetailRow>
				<DetailRow label={`v${b.versionNumber}`}>
					<a href={`/procedures/versions/${b.id}`} class="text-info hover:underline">View</a>
					· <Timestamp value={b.createdAt} />
				</DetailRow>
				<DetailRow label={`v${b.versionNumber} note`} value={b.changeNote} />
			</DetailTable>
		</Section>
		{#if d.procedureChanges.length === 0}
			<EmptyLine label="Template changes" />
		{:else}
			<Section title="Template" count={d.procedureChanges.length}>
				<DataTable
					rows={d.procedureChanges}
					columns={procColumns}
					emptyLabel="Template changes"
					dense
					key={(r) => r.field}
				>
					{#snippet cell(r, col)}
						{#if col.key === 'field'}
							{FIELD_LABELS[r.field] ?? r.field}
						{:else}
							{brief(col.key === 'a' ? r.a : r.b)}
						{/if}
					{/snippet}
				</DataTable>
			</Section>
		{/if}
	</div>
</div>
