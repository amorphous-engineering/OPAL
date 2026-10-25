<script lang="ts">
	import { goto } from '$app/navigation';
	import { opal } from '#lib/api.js';
	import { PageHeader, Section, toastError, ErrorBanner } from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import ProjectSelect from '#lib/components/projects/ProjectSelect.svelte'; // added by projects
	import UnitPicker from '#lib/components/opal/UnitPicker.svelte';
	import SpecEditor from '#lib/components/datasets/SpecEditor.svelte';
	import {
		blankSpec,
		badBoxes,
		specFromDraft,
		type SpecDraft
	} from '#lib/components/datasets/spec-draft.js';
	import type { SchemaField } from '#lib/components/datasets/types.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	type Row = {
		name: string;
		type: SchemaField['type'];
		unit: string;
		chart: boolean;
		required: boolean;
		spec: SpecDraft;
	};
	const blank = (): Row => ({
		name: '',
		type: 'number',
		unit: '',
		chart: true,
		required: false,
		spec: blankSpec()
	});

	let name = $state('');
	let description = $state('');
	// svelte-ignore state_referenced_locally
	let procedure = $state(data.procedure);
	// added by projects: the project comes from the page it was opened from, else from the procedure.
	// svelte-ignore state_referenced_locally
	let projectId = $state(data.projectId);
	$effect(() => {
		const linked = data.procedures.find((p) => String(p.id) === procedure)?.projectId;
		if (linked && !data.projectId) projectId = linked;
	});
	let rows = $state<Row[]>([blank()]);
	let busy = $state(false);
	let error = $state<string | null>(null);

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		error = null;
		const named = rows.filter((r) => r.name.trim());
		for (const r of named) {
			if (r.type !== 'number') continue;
			const bad = badBoxes(r.spec).some(Boolean) || specFromDraft(r.spec).error;
			if (bad) return (error = `Spec of '${r.name.trim()}' is not valid`);
		}
		const fields: SchemaField[] = named.map((r) => ({
			name: r.name.trim(),
			type: r.type,
			...(r.type === 'number' && r.unit ? { unit: r.unit } : {}),
			...(r.type === 'number' && r.chart ? { chart: true } : {}),
			...(r.required ? { required: true } : {}),
			...(r.type === 'number' && specFromDraft(r.spec).spec
				? { spec: specFromDraft(r.spec).spec }
				: {})
		}));
		if (fields.length === 0) return (error = 'At least one field is required');
		const names = fields.map((f) => f.name);
		const dup = names.find((n, i) => names.indexOf(n) !== i);
		if (dup) return (error = `Field name '${dup}' is used twice`);
		busy = true;
		try {
			const created = await opal.datasets.create({
				projectId, // added by projects
				name: name.trim(),
				description: description.trim() || null,
				procedureId: procedure ? Number(procedure) : null,
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

<form class="grid max-w-6xl grid-cols-1 gap-4 p-4" onsubmit={submit}>
	<Section title="Dataset">
		<div class="grid grid-cols-1 gap-3 p-3">
			<div class="grid grid-cols-1 gap-1.5">
				<Label for="ds-project">Project</Label>
				<ProjectSelect id="ds-project" bind:value={projectId} />
			</div>
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
					{#each ['Name', 'Type', 'Unit', 'Spec', 'Required', 'Chart', ''] as h (h)}
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
							><Input
								bind:value={row.name}
								aria-label={`Field ${i + 1} name`}
								class="min-w-40"
							/></td
						>
						<td class="px-3 py-1.5">
							<NativeSelect
								bind:value={row.type}
								aria-label={`Field ${i + 1} type`}
								class="min-w-28"
							>
								<NativeSelectOption value="number">Number</NativeSelectOption>
								<NativeSelectOption value="text">Text</NativeSelectOption>
								<NativeSelectOption value="boolean">Boolean</NativeSelectOption>
								<NativeSelectOption value="date">Date</NativeSelectOption>
							</NativeSelect>
						</td>
						<td class="px-3 py-1.5">
							{#if row.type === 'number'}
								<UnitPicker bind:value={row.unit} label={`Field ${i + 1} unit`} />
							{:else}<span class="text-muted-foreground">—</span>{/if}
						</td>
						<td class="px-3 py-1.5">
							{#if row.type === 'number'}
								<SpecEditor bind:draft={row.spec} unit={row.unit} label={`Field ${i + 1} spec`} />
							{:else}<span class="text-muted-foreground">—</span>{/if}
						</td>
						<td class="px-3 py-1.5">
							<Checkbox bind:checked={row.required} aria-label={`Field ${i + 1} required`} />
						</td>
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

	<ErrorBanner message={error} />
	<div class="flex gap-2">
		<Button type="submit" disabled={busy || !name.trim() || !projectId}>CREATE</Button>
		<Button variant="outline" href="/datasets">CANCEL</Button>
	</div>
</form>
