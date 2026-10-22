<script lang="ts">
	import {
		DataTable,
		PageHeader,
		Section,
		State,
		type Column
	} from '#lib/components/opal/index.js';
	import { toastError } from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { api } from '#lib/api.js';
	import { qty } from '#lib/format.js';

	interface Row {
		row_number: number;
		name: string | null;
		external_pn: string | null;
		tier: number | null;
		category: string | null;
		unit_of_measure: string | null;
		tracking_type: string | null;
		procurement: string | null;
		description: string | null;
		reorder_point: number | null;
		errors: string[];
		warnings: string[];
		valid: boolean;
	}
	interface Preview {
		total_rows: number;
		valid_rows: number;
		error_rows: number;
		warning_rows: number;
		rows: Row[];
		headers_found: string[];
	}
	interface Result {
		created: number;
		skipped: number;
		errors: string[];
		first_pn: string | null;
		last_pn: string | null;
	}

	let files = $state<FileList | undefined>();
	let preview = $state<Preview | null>(null);
	let result = $state<Result | null>(null);
	let skipDuplicates = $state(true);
	let busy = $state(false);
	let filename = $state('');

	async function onFile() {
		const file = files?.[0];
		preview = null;
		result = null;
		if (!file) return;
		filename = file.name;
		busy = true;
		try {
			const form = new FormData();
			form.append('file', file);
			preview = await api.post<Preview>('/parts/import/preview', form);
		} catch (e) {
			toastError(e);
		} finally {
			busy = false;
		}
	}

	const importable = $derived(
		preview ? preview.rows.filter((r) => r.valid && !(skipDuplicates && r.warnings.length)) : []
	);

	async function commit() {
		if (!preview) return;
		busy = true;
		try {
			result = await api.post<Result>('/parts/import', {
				skip_duplicates: skipDuplicates,
				rows: preview.rows
					.filter((r) => r.valid)
					.map((r) => ({
						name: r.name,
						external_pn: r.external_pn,
						tier: r.tier ?? undefined,
						category: r.category,
						unit_of_measure: r.unit_of_measure ?? undefined,
						tracking_type: r.tracking_type,
						procurement: r.procurement ?? undefined,
						description: r.description,
						reorder_point: r.reorder_point
					}))
			});
			preview = null;
			files = undefined;
		} catch (e) {
			toastError(e);
		} finally {
			busy = false;
		}
	}

	function template() {
		const csv =
			'name,external_pn,tier,category,unit_of_measure,tracking_type,procurement,description,reorder_point\n';
		const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
		const a = Object.assign(document.createElement('a'), {
			href: url,
			download: 'parts-template.csv'
		});
		a.click();
		URL.revokeObjectURL(url);
	}

	const columns: Column<Row>[] = [
		{ key: 'row_number', label: 'Row', width: '4rem', mono: true, align: 'right' },
		{ key: 'name', label: 'Name' },
		{ key: 'external_pn', label: 'External PN', mono: true, width: '12rem' },
		{ key: 'tier', label: 'Tier', width: '4rem', mono: true },
		{ key: 'category', label: 'Category', width: '9rem' },
		{ key: 'procurement', label: 'Proc', width: '5rem' },
		{ key: 'reorder_point', label: 'Reorder', width: '6rem', align: 'right', mono: true },
		{ key: 'result', label: 'Result', width: '20rem' }
	];
</script>

<PageHeader title="Import parts" crumbs={[{ label: 'Parts', href: '/parts' }, { label: 'Import' }]}>
	{#snippet actions()}
		<Button variant="outline" size="sm" onclick={template}>TEMPLATE CSV</Button>
	{/snippet}
</PageHeader>

<div class="grid gap-4 p-4">
	<Section title="File" class="max-w-3xl">
		<div class="flex flex-wrap items-end gap-3 p-3">
			<div class="grid gap-1.5">
				<Label for="csv" class="label">CSV file</Label>
				<Input
					id="csv"
					type="file"
					accept=".csv,text/csv"
					bind:files
					onchange={onFile}
					class="w-80"
				/>
			</div>
			<div class="flex items-center gap-2 pb-2">
				<Checkbox id="skip" bind:checked={skipDuplicates} />
				<Label for="skip" class="label">Skip duplicate names</Label>
			</div>
			{#if preview}
				<Button onclick={commit} disabled={busy || importable.length === 0} class="mb-px">
					IMPORT {importable.length}
					{importable.length === 1 ? 'PART' : 'PARTS'}
				</Button>
			{/if}
		</div>
		{#if preview}
			<p class="border-t border-border px-3 py-2 font-mono text-xs text-muted-foreground">
				{filename} · {preview.total_rows} rows · {preview.valid_rows} valid · {preview.error_rows} errors
				·
				{preview.warning_rows} duplicates · columns {preview.headers_found.join(', ')}
			</p>
		{/if}
	</Section>

	{#if result}
		<Section title="Imported" class="max-w-3xl">
			<dl class="grid [grid-template-columns:max-content_1fr] gap-1 gap-x-4 p-3 text-sm">
				<dt class="label">Created</dt>
				<dd class="mono">
					{result.created}{#if result.first_pn}<span class="text-muted-foreground">
							· {result.first_pn} – {result.last_pn}</span
						>{/if}
				</dd>
				<dt class="label">Skipped</dt>
				<dd class="mono">{result.skipped}</dd>
				{#if result.errors.length}
					<dt class="label">Errors</dt>
					<dd class="text-error">
						{#each result.errors as e (e)}<div>{e}</div>{/each}
					</dd>
				{/if}
			</dl>
			<div class="border-t border-border px-3 py-2">
				<a href="/parts?state=draft" class="font-mono text-xs font-medium text-info hover:underline"
					>DRAFT PARTS →</a
				>
			</div>
		</Section>
	{/if}

	{#if preview}
		<Section title="Preview" count={preview.total_rows}>
			<DataTable
				rows={preview.rows}
				{columns}
				key={(r) => r.row_number}
				rowClass={(r) => (r.valid ? undefined : 'bg-error-muted/40')}
				emptyLabel="ROWS"
			>
				{#snippet cell(r, col)}
					{#if col.key === 'result'}
						{#if !r.valid}
							<State value="error" tone="error" label="ERROR" />
							<span class="text-xs text-error">{r.errors.join('; ')}</span>
						{:else if r.warnings.length}
							<State value="dup" tone="warn" label="DUPLICATE" />
							<span class="text-xs text-muted-foreground"
								>{skipDuplicates ? 'skipped' : 'imported'}</span
							>
						{:else}
							<State value="ok" tone="ok" label="OK" />
						{/if}
					{:else if col.key === 'reorder_point'}
						{r.reorder_point === null ? '—' : qty(r.reorder_point)}
					{:else}
						{@const v = (r as unknown as Record<string, unknown>)[col.key]}
						{#if v === null || v === ''}<span class="text-muted-foreground">—</span>{:else}{v}{/if}
					{/if}
				{/snippet}
			</DataTable>
		</Section>
	{/if}
</div>
