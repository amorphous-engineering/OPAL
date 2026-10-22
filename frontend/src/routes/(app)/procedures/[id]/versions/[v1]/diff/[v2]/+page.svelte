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
	const a = $derived(d.version_a);
	const b = $derived(d.version_b);
	let showUnchanged = $state(false);

	const FIELD_LABELS: Record<string, string> = {
		title: 'title',
		instructions: 'instructions',
		is_contingency: 'contingency',
		estimated_duration_minutes: 'duration (min)',
		required_role: 'role',
		caution: 'caution',
		required_data_schema: 'data fields',
		requires_signoff: 'signoff',
		strict_sequence: 'strict sequence',
		depends_on: 'dependencies',
		step_kit: 'step kit',
		images: 'images',
		procedure_name: 'name',
		procedure_description: 'description'
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
	function describe(field: string, ch: { a: unknown; b: unknown }): string {
		const label = FIELD_LABELS[field] ?? field;
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
		{ key: 'step_number', label: '#', width: '5rem', mono: true },
		{ key: 'status', label: 'Change', width: '7rem' },
		{ key: 'title_a', label: 'From' },
		{ key: 'title_b', label: 'To' },
		{ key: 'changed_fields', label: 'Changed' }
	];
	const partColumns = $derived<Column<PartDiff>[]>([
		{ key: 'internal_pn', label: 'Part', width: '9rem', mono: true },
		{ key: 'name', label: 'Name' },
		{ key: 'status', label: 'Change', width: '7rem' },
		{ key: 'quantity_a', label: `v${a.version_number}`, align: 'right', width: '7rem', mono: true },
		{ key: 'quantity_b', label: `v${b.version_number}`, align: 'right', width: '7rem', mono: true }
	]);
	const procColumns = $derived<Column<(typeof d.procedure_changes)[number]>[]>([
		{ key: 'field', label: 'Field', width: '10rem' },
		{ key: 'a', label: `v${a.version_number}` },
		{ key: 'b', label: `v${b.version_number}` }
	]);
</script>

{#snippet partDiff(title: string, rows: PartDiff[])}
	{#if rows.length === 0}
		<EmptyLine label={`${title} changes`} />
	{:else}
		<Section {title} count={rows.length}>
			<DataTable {rows} columns={partColumns} emptyLabel={title} dense key={(r) => r.part_id}>
				{#snippet cell(r, col)}
					{#if col.key === 'internal_pn'}
						<a href={`/parts/${r.part_id}`} class="text-info hover:underline"
							>{r.internal_pn ?? '—'}</a
						>
					{:else if col.key === 'name'}
						{r.name ?? '—'}
					{:else if col.key === 'status'}
						<State value={r.status} tone={TONES[r.status]} />
					{:else if col.key === 'quantity_a'}
						{qty(r.quantity_a)}
					{:else if col.key === 'quantity_b'}
						{qty(r.quantity_b)}
					{/if}
				{/snippet}
			</DataTable>
		</Section>
	{/if}
{/snippet}

<PageHeader
	title={d.procedure_name}
	identifier={`v${a.version_number} → v${b.version_number}`}
	crumbs={[
		{ label: 'Templates', href: '/procedures' },
		{ label: d.procedure_name, href: `/procedures/${d.procedure_id}` },
		{ label: 'Diff' }
	]}
>
	{#snippet actions()}
		<Button variant="outline" href={`/procedures/${d.procedure_id}/versions/${b.id}/diff/${a.id}`}
			>SWAP</Button
		>
		<Button variant="outline" href={`/procedures/${d.procedure_id}`}>TEMPLATE</Button>
	{/snippet}
</PageHeader>

<div class="grid items-start gap-4 p-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
	<div class="grid min-w-0 gap-4">
		<Section
			title="Steps"
			count={`${d.added} ADDED · ${d.removed} REMOVED · ${d.modified} MODIFIED`}
		>
			{#snippet actions()}
				<div class="flex items-center gap-2">
					<Checkbox id="show-unchanged" bind:checked={showUnchanged} />
					<Label for="show-unchanged" class="font-mono text-[11px] uppercase"
						>Unchanged ({d.unchanged})</Label
					>
				</div>
			{/snippet}
			<DataTable
				rows={visibleSteps}
				columns={stepColumns}
				emptyLabel="Step changes"
				dense
				key={(r) => r.step_number}
			>
				{#snippet cell(r, col)}
					{#if col.key === 'status'}
						<State value={r.status} tone={TONES[r.status]} />
					{:else if col.key === 'title_a'}
						<span class={r.status === 'removed' ? 'text-error' : ''}>{r.title_a ?? '—'}</span>
					{:else if col.key === 'title_b'}
						<span class={r.status === 'added' ? 'text-ok' : ''}>{r.title_b ?? '—'}</span>
					{:else if col.key === 'changed_fields'}
						{#if r.changed_fields.length}
							<ul class="grid gap-0.5 font-mono text-xs">
								{#each r.changed_fields as f (f)}<li>{describe(f, r.changes[f])}</li>{/each}
							</ul>
						{:else}<span class="text-muted-foreground">—</span>{/if}
					{:else}
						{r.step_number}
					{/if}
				{/snippet}
			</DataTable>
		</Section>
		{@render partDiff('Kit', d.kit)}
		{@render partDiff('Outputs', d.outputs)}
	</div>

	<div class="grid min-w-0 gap-4">
		<Section title="Versions">
			<DetailTable>
				<DetailRow label={`v${a.version_number}`}>
					<a href={`/procedures/versions/${a.id}`} class="text-info hover:underline">View</a>
					· <Timestamp value={a.created_at} />
				</DetailRow>
				<DetailRow label={`v${b.version_number}`}>
					<a href={`/procedures/versions/${b.id}`} class="text-info hover:underline">View</a>
					· <Timestamp value={b.created_at} />
				</DetailRow>
				<DetailRow label={`v${b.version_number} note`} value={b.change_note} />
			</DetailTable>
		</Section>
		{#if d.procedure_changes.length === 0}
			<EmptyLine label="Template changes" />
		{:else}
			<Section title="Template" count={d.procedure_changes.length}>
				<DataTable
					rows={d.procedure_changes}
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
