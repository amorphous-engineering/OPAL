<script lang="ts">
	import {
		ActionLink,
		DataTable,
		DetailRow,
		DetailTable,
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
	import { opal } from '#lib/api.js';
	import { qty } from '#lib/format.js';
	import type {
		ImportPreview as Preview,
		ImportPreviewRow as Row,
		ImportResult as Result,
		PartCreate
	} from '@opal/shared';

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
			preview = await opal.parts.importPreview({ csv: await file.text() });
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
			result = await opal.parts.import({
				skipDuplicates,
				rows: preview.rows
					.filter((r) => r.valid)
					.map((r): PartCreate => ({
						name: r.name!,
						externalPn: r.externalPn,
						tier: r.tier ?? 1,
						category: r.category,
						unitOfMeasure: r.unitOfMeasure ?? undefined,
						trackingType: (r.trackingType as PartCreate['trackingType']) ?? undefined,
						procurement: (r.procurement as PartCreate['procurement']) ?? undefined,
						description: r.description,
						reorderPoint: r.reorderPoint
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
		{ key: 'rowNumber', label: 'Row', width: '4rem', mono: true, align: 'right' },
		{ key: 'name', label: 'Name' },
		{ key: 'externalPn', label: 'External PN', mono: true, width: '12rem' },
		{ key: 'tier', label: 'Tier', width: '4rem', mono: true },
		{ key: 'category', label: 'Category', width: '9rem' },
		{ key: 'procurement', label: 'Proc', width: '5rem' },
		{ key: 'reorderPoint', label: 'Reorder', width: '6rem', align: 'right', mono: true },
		{ key: 'result', label: 'Result', width: '20rem' }
	];
</script>

<PageHeader title="Import parts" crumbs={[{ label: 'Parts', href: '/parts' }, { label: 'Import' }]}>
	{#snippet actions()}
		<Button variant="outline" size="sm" onclick={template}>TEMPLATE CSV</Button>
	{/snippet}
</PageHeader>

<div class="grid grid-cols-1 gap-4 p-4">
	<Section title="File" class="max-w-3xl">
		<div class="flex flex-wrap items-end gap-3 p-3">
			<div class="grid grid-cols-1 gap-1.5">
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
				{filename} · {preview.totalRows}
				{preview.totalRows === 1 ? 'row' : 'rows'} · {preview.validRows}
				valid · {preview.errorRows}
				{preview.errorRows === 1 ? 'error' : 'errors'} · {preview.warningRows}
				{preview.warningRows === 1 ? 'duplicate' : 'duplicates'}
			</p>
		{/if}
	</Section>

	{#if result}
		<Section title="Imported" class="max-w-3xl">
			<DetailTable>
				<DetailRow label="Created" value={result.created} mono />
				<DetailRow label="Skipped" value={result.skipped} mono />
				{#if result.errors.length}
					<DetailRow label="Errors">
						{#each result.errors as e (e)}<div class="text-error">{e}</div>{/each}
					</DetailRow>
				{/if}
			</DetailTable>
			<div class="border-t border-border px-3 py-2">
				<ActionLink href="/parts?state=draft">DRAFT PARTS →</ActionLink>
			</div>
		</Section>
	{/if}

	{#if preview}
		<Section title="Preview" count={preview.totalRows}>
			<DataTable
				rows={preview.rows}
				{columns}
				key={(r) => r.rowNumber}
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
							<span class="text-muted-foreground">—</span>
						{/if}
					{:else if col.key === 'reorderPoint'}
						{r.reorderPoint === null ? '—' : qty(r.reorderPoint)}
					{:else}
						{@const v = (r as unknown as Record<string, unknown>)[col.key]}
						{#if v === null || v === ''}<span class="text-muted-foreground">—</span>{:else}{v}{/if}
					{/if}
				{/snippet}
			</DataTable>
		</Section>
	{/if}
</div>
