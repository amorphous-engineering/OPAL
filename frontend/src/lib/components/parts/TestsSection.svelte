<script lang="ts">
	// Acceptance tests declared on the part; each stock record of the part runs them.
	import {
		ActionLink,
		DataTable,
		EmptyLine,
		Section,
		confirm,
		type Column
	} from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { NativeSelect } from '#lib/components/ui/native-select/index.js';
	import { opal } from '#lib/api.js';
	import { qty, stateLabel } from '#lib/format.js';
	import type { StockTestTemplate } from '@opal/shared';
	import FormField from './FormField.svelte';
	import { act } from './actions.js';

	let { partId, templates }: { partId: number; templates: StockTestTemplate[] } = $props();

	let adding = $state(false);
	let busy = $state(false);
	let name = $state('');
	let type = $state<StockTestTemplate['testType']>('boolean');
	let min = $state('');
	let max = $state('');
	let unit = $state('');
	let required = $state(false);

	const columns: Column<StockTestTemplate>[] = [
		{ key: 'name', label: 'Test' },
		{ key: 'type', label: 'Type', width: '8rem' },
		{ key: 'range', label: 'Range', width: '12rem', mono: true },
		{ key: 'required', label: 'Required', width: '7rem' },
		{ key: 'actions', label: '', width: '5rem', align: 'right' }
	];

	function range(t: StockTestTemplate): string | null {
		if (t.testType !== 'numeric') return null;
		const lo = t.minValue === null ? '' : qty(t.minValue);
		const hi = t.maxValue === null ? '' : qty(t.maxValue);
		if (!lo && !hi) return null;
		return `${lo}–${hi}${t.unit ? ` ${t.unit}` : ''}`;
	}

	async function add(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		const numeric = type === 'numeric';
		const ok = await act(
			() =>
				opal.inventory.templates.create({
					partId,
					name: name.trim(),
					testType: type,
					required,
					minValue: numeric && String(min).trim() ? String(min).trim() : null,
					maxValue: numeric && String(max).trim() ? String(max).trim() : null,
					unit: numeric && unit.trim() ? unit.trim() : null
				}),
			'Test added'
		);
		busy = false;
		if (ok) {
			name = min = max = unit = '';
			required = false;
			adding = false;
		}
	}

	async function remove(t: StockTestTemplate) {
		const ok = await confirm({
			title: `Delete test ${t.name}`,
			body: 'Results already recorded against stock keep their test name.',
			action: 'DELETE',
			destructive: true
		});
		if (ok)
			await act(
				() => opal.inventory.templates.delete({ partId, templateId: t.id }),
				'Test deleted'
			);
	}
</script>

{#snippet form()}
	<form
		class="flex flex-wrap items-end gap-2 border-t border-border bg-muted/30 p-2"
		onsubmit={add}
	>
		<FormField label="Name" for="test-name" class="w-56">
			<Input id="test-name" bind:value={name} required />
		</FormField>
		<FormField label="Type" for="test-type" class="w-36">
			<NativeSelect id="test-type" class="w-full" bind:value={type}>
				<option value="boolean">PASS / FAIL</option>
				<option value="numeric">NUMERIC</option>
				<option value="text">TEXT</option>
			</NativeSelect>
		</FormField>
		{#if type === 'numeric'}
			<FormField label="Min" for="test-min" class="w-24">
				<Input id="test-min" class="font-mono" inputmode="decimal" bind:value={min} />
			</FormField>
			<FormField label="Max" for="test-max" class="w-24">
				<Input id="test-max" class="font-mono" inputmode="decimal" bind:value={max} />
			</FormField>
			<FormField label="Unit" for="test-unit" class="w-24">
				<Input id="test-unit" class="font-mono" bind:value={unit} />
			</FormField>
		{/if}
		<div class="flex items-center gap-2 pb-2">
			<Checkbox id="test-required" bind:checked={required} />
			<Label for="test-required" class="label">Required</Label>
		</div>
		<Button type="submit" size="sm" disabled={busy}>ADD</Button>
	</form>
{/snippet}

{#if templates.length}
	<Section title="Tests" count={templates.length}>
		{#snippet actions()}
			<ActionLink onclick={() => (adding = !adding)}>{adding ? 'CANCEL' : '+ ADD'}</ActionLink>
		{/snippet}
		<DataTable rows={templates} {columns} key={(t) => t.id} emptyLabel="TESTS">
			{#snippet cell(t, col)}
				{#if col.key === 'name'}
					{t.name}
				{:else if col.key === 'type'}
					<span class="font-mono text-xs text-muted-foreground">{stateLabel(t.testType)}</span>
				{:else if col.key === 'range'}
					{@const r = range(t)}
					{#if r}{r}{:else}<span class="text-muted-foreground">—</span>{/if}
				{:else if col.key === 'required'}
					{#if t.required}<span class="font-mono text-xs">REQUIRED</span>{:else}<span
							class="text-muted-foreground">—</span
						>{/if}
				{:else}
					<ActionLink danger onclick={() => remove(t)}>DELETE</ActionLink>
				{/if}
			{/snippet}
		</DataTable>
		{#if adding}{@render form()}{/if}
	</Section>
{:else}
	<div>
		<EmptyLine label="TESTS" onadd={() => (adding = true)} />
		{#if adding}{@render form()}{/if}
	</div>
{/if}
