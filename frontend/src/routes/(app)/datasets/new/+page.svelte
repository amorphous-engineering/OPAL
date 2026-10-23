<script lang="ts">
	import { goto } from '$app/navigation';
	import { api } from '#lib/api.js';
	import { PageHeader, Section, toastError } from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import type { DatasetSummary, SchemaField } from '#lib/components/datasets/types.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	type Row = { name: string; type: SchemaField['type']; unit: string; chart: boolean };
	const blank = (): Row => ({ name: '', type: 'number', unit: '', chart: true });

	let name = $state('');
	let description = $state('');
	// svelte-ignore state_referenced_locally
	let procedure = $state(data.procedure);
	let rows = $state<Row[]>([blank()]);
	let busy = $state(false);
	let error = $state<string | null>(null);

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		error = null;
		const fields: SchemaField[] = rows
			.filter((r) => r.name.trim())
			.map((r) => ({
				name: r.name.trim(),
				type: r.type,
				...(r.unit.trim() ? { unit: r.unit.trim() } : {}),
				...(r.type === 'number' && r.chart ? { chart: true } : {})
			}));
		if (fields.length === 0) return (error = 'At least one field is required');
		const names = fields.map((f) => f.name);
		const dup = names.find((n, i) => names.indexOf(n) !== i);
		if (dup) return (error = `Field name '${dup}' is used twice`);
		busy = true;
		try {
			const created = await api.post<DatasetSummary>('/datasets', {
				name: name.trim(),
				description: description.trim() || null,
				procedure_id: procedure ? Number(procedure) : null,
				schema: { fields }
			});
			await goto(`/datasets/${created.id}`);
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to create dataset';
			toastError(err);
		} finally {
			busy = false;
		}
	}
</script>

<PageHeader
	title="New dataset"
	crumbs={[{ label: 'Datasets', href: '/datasets' }, { label: 'New' }]}
/>

<form class="grid max-w-3xl grid-cols-1 gap-4 p-4" onsubmit={submit}>
	<Section title="Dataset">
		<div class="grid grid-cols-1 gap-3 p-3">
			<div class="grid grid-cols-1 gap-1.5">
				<Label for="ds-name">Name</Label>
				<Input id="ds-name" bind:value={name} required maxlength={255} />
			</div>
			<div class="grid grid-cols-1 gap-1.5">
				<Label for="ds-desc">Description</Label>
				<Textarea id="ds-desc" bind:value={description} rows={2} />
			</div>
			<div class="grid grid-cols-1 gap-1.5">
				<Label for="ds-proc">Procedure</Label>
				<NativeSelect id="ds-proc" bind:value={procedure} class="w-full max-w-sm">
					<NativeSelectOption value="">None</NativeSelectOption>
					{#each data.procedures as p (p.id)}
						<NativeSelectOption value={String(p.id)}>{p.name}</NativeSelectOption>
					{/each}
				</NativeSelect>
			</div>
		</div>
	</Section>

	<Section title="Fields" count={rows.length}>
		{#snippet actions()}
			<Button
				type="button"
				variant="ghost"
				size="xs"
				class="font-mono text-info"
				onclick={() => rows.push(blank())}>+ ADD FIELD</Button
			>
		{/snippet}
		<table class="w-full border-collapse text-sm">
			<thead>
				<tr class="border-b border-border bg-muted/60">
					{#each ['Name', 'Type', 'Unit', 'Chart', ''] as h (h)}
						<th
							class="h-8 px-3 text-left font-mono text-xs font-medium tracking-wider text-muted-foreground uppercase"
							>{h}</th
						>
					{/each}
				</tr>
			</thead>
			<tbody>
				{#each rows as row, i (i)}
					<tr class="border-b border-border last:border-b-0">
						<td class="px-3 py-1.5"
							><Input bind:value={row.name} aria-label={`Field ${i + 1} name`} /></td
						>
						<td class="px-3 py-1.5">
							<NativeSelect bind:value={row.type} aria-label={`Field ${i + 1} type`}>
								<NativeSelectOption value="number">Number</NativeSelectOption>
								<NativeSelectOption value="text">Text</NativeSelectOption>
								<NativeSelectOption value="boolean">Boolean</NativeSelectOption>
								<NativeSelectOption value="date">Date</NativeSelectOption>
							</NativeSelect>
						</td>
						<td class="px-3 py-1.5"
							><Input bind:value={row.unit} aria-label={`Field ${i + 1} unit`} class="w-28" /></td
						>
						<td class="px-3 py-1.5">
							{#if row.type === 'number'}
								<Checkbox bind:checked={row.chart} aria-label={`Field ${i + 1} charted`} />
							{:else}<span class="text-muted-foreground">—</span>{/if}
						</td>
						<td class="px-3 py-1.5 text-right">
							<Button
								type="button"
								variant="ghost"
								size="xs"
								disabled={rows.length === 1}
								onclick={() => rows.splice(i, 1)}>REMOVE</Button
							>
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</Section>

	{#if error}
		<p
			role="alert"
			class="rounded-md border border-error/40 bg-error-muted px-2 py-1.5 text-xs text-error"
		>
			{error}
		</p>
	{/if}
	<div class="flex gap-2">
		<Button type="submit" disabled={busy || !name.trim()}>CREATE</Button>
		<Button variant="outline" href="/datasets">CANCEL</Button>
	</div>
</form>
