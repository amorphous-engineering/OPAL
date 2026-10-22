<script lang="ts">
	// DESIGN: requirements allocated to the part and the acceptance tests its
	// stock records are held to. Always relevant: empty = one line.
	import {
		DataTable,
		EmptyLine,
		Section,
		State,
		confirm,
		type Column
	} from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import { api } from '#lib/api.js';
	import { qty, stateLabel } from '#lib/format.js';
	import { ActionLink } from '#lib/components/opal/index.js';
	import FormField from './FormField.svelte';
	import { act } from './actions.js';
	import type { PartDetail, RequirementAllocation, TestTemplate } from './types.js';

	let { detail }: { detail: PartDetail } = $props();
	const part = $derived(detail.part);

	// ---- requirements ----
	let addingReq = $state(false);
	let reqNumber = $state('');
	let busy = $state(false);

	const reqColumns: Column<RequirementAllocation>[] = [
		{ key: 'req', label: 'Req', width: '7rem', mono: true },
		{ key: 'title', label: 'Title' },
		{ key: 'state', label: 'State', width: '6.5rem' },
		{ key: 'status', label: 'Allocation', width: '7rem' },
		{ key: 'actions', label: '', width: '4.5rem', align: 'right' }
	];

	const flags = $derived({
		tbd: detail.requirements.filter((r) => r.tbd).length,
		tbr: detail.requirements.filter((r) => r.tbr).length,
		stale: detail.requirements.filter((r) => r.stale).length
	});

	async function assign(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		const ok = await act(
			() =>
				api.post(`/requirements/parts/${part.id}`, {
					requirement_id: reqNumber.trim().toUpperCase()
				}),
			'Requirement allocated'
		);
		busy = false;
		if (ok) {
			reqNumber = '';
			addingReq = false;
		}
	}

	async function unassign(r: RequirementAllocation) {
		const ok = await confirm({
			title: `Remove ${r.requirement_id} from ${part.internal_pn}`,
			body: 'The allocation and its verification status are deleted. The requirement itself is unchanged.',
			action: 'REMOVE',
			destructive: true
		});
		if (ok)
			await act(
				() => api.del(`/requirements/allocations/${r.allocation_id}`),
				'Allocation removed'
			);
	}

	// ---- tests ----
	let addingTest = $state(false);
	let tName = $state('');
	let tType = $state<'boolean' | 'numeric' | 'text'>('boolean');
	let tMin = $state('');
	let tMax = $state('');
	let tUnit = $state('');
	let tRequired = $state(false);

	const testColumns: Column<TestTemplate>[] = [
		{ key: 'name', label: 'Name' },
		{ key: 'type', label: 'Type', width: '8rem' },
		{ key: 'range', label: 'Range', width: '10rem', mono: true },
		{ key: 'actions', label: '', width: '4.5rem', align: 'right' }
	];

	function range(t: TestTemplate): string | null {
		if (t.test_type !== 'numeric') return null;
		const lo = t.min_value === null ? '' : qty(t.min_value);
		const hi = t.max_value === null ? '' : qty(t.max_value);
		if (!lo && !hi) return null;
		return `${lo}–${hi}${t.unit ? ` ${t.unit}` : ''}`;
	}

	async function addTest(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		const body: Record<string, unknown> = {
			name: tName.trim(),
			test_type: tType,
			required: tRequired
		};
		if (tType === 'numeric') {
			if (tMin !== '') body.min_value = Number(tMin);
			if (tMax !== '') body.max_value = Number(tMax);
			if (tUnit.trim()) body.unit = tUnit.trim();
		}
		const ok = await act(
			() => api.post(`/inventory/parts/${part.id}/test-templates`, body),
			'Test added'
		);
		busy = false;
		if (ok) {
			tName = '';
			tMin = tMax = tUnit = '';
			tRequired = false;
			addingTest = false;
		}
	}

	async function removeTest(t: TestTemplate) {
		const ok = await confirm({
			title: `Delete test ${t.name}`,
			body: 'Results already recorded against stock keep their test name.',
			action: 'DELETE',
			destructive: true
		});
		if (ok)
			await act(
				() => api.del(`/inventory/parts/${part.id}/test-templates/${t.id}`),
				'Test deleted'
			);
	}
</script>

<!-- REQUIREMENTS -->
{#snippet reqForm()}
	<form
		class="flex flex-wrap items-end gap-2 border-t border-border bg-muted/30 p-2"
		onsubmit={assign}
	>
		<FormField label="Requirement" for="req-number" class="w-44">
			<Input
				id="req-number"
				class="font-mono"
				placeholder="REQ-0007"
				bind:value={reqNumber}
				required
			/>
		</FormField>
		<Button type="submit" size="sm" disabled={busy}>ALLOCATE</Button>
	</form>
{/snippet}

{#if detail.requirements.length}
	<Section
		title="Requirements"
		count={[
			detail.requirements.length,
			flags.tbd ? `${flags.tbd} TBD` : '',
			flags.tbr ? `${flags.tbr} TBR` : '',
			flags.stale ? `${flags.stale} STALE` : ''
		]
			.filter(Boolean)
			.join(' · ')}
	>
		{#snippet actions()}
			<ActionLink onclick={() => (addingReq = !addingReq)}
				>{addingReq ? 'CANCEL' : '+ ADD'}</ActionLink
			>
		{/snippet}
		<DataTable
			rows={detail.requirements}
			columns={reqColumns}
			key={(r) => r.allocation_id}
			href={(r) => (r.requirement_ref_id ? `/requirements/${r.requirement_ref_id}` : null)}
			emptyLabel="REQUIREMENTS"
		>
			{#snippet cell(r, col)}
				{#if col.key === 'req'}
					{#if r.requirement_ref_id}<a
							href={`/requirements/${r.requirement_ref_id}`}
							class="text-info hover:underline">{r.requirement_id}</a
						>{:else}{r.requirement_id}{/if}
				{:else if col.key === 'title'}
					{#if r.title}{r.title}{:else}<span class="text-muted-foreground">—</span>{/if}
					{#if r.tbd}<State value="tbd" tone="warn" label="TBD" class="ml-2" />{/if}
					{#if r.tbr}<State value="tbr" tone="warn" label="TBR" class="ml-2" />{/if}
					{#if r.stale}<State value="stale" tone="warn" label="STALE" class="ml-2" />{/if}
				{:else if col.key === 'state'}
					<span class="font-mono text-xs text-muted-foreground"
						>{stateLabel(r.lifecycle_state)}</span
					>
				{:else if col.key === 'status'}
					<State
						value={r.status}
						tone={r.status === 'verified' ? 'ok' : r.status === 'open' ? 'default' : 'muted'}
					/>
				{:else}
					<ActionLink danger onclick={() => unassign(r)}>REMOVE</ActionLink>
				{/if}
			{/snippet}
		</DataTable>
		{#if addingReq}{@render reqForm()}{/if}
	</Section>
{:else}
	<div>
		<EmptyLine label="REQUIREMENTS" onadd={() => (addingReq = true)} />
		{#if addingReq}{@render reqForm()}{/if}
	</div>
{/if}

<!-- TESTS -->
{#snippet testForm()}
	<form
		class="flex flex-wrap items-end gap-2 border-t border-border bg-muted/30 p-2"
		onsubmit={addTest}
	>
		<FormField label="Name" for="test-name" class="w-48">
			<Input id="test-name" bind:value={tName} required />
		</FormField>
		<FormField label="Type" for="test-type" class="w-32">
			<NativeSelect.Root id="test-type" size="sm" class="w-full" bind:value={tType}>
				<NativeSelect.Option value="boolean">PASS / FAIL</NativeSelect.Option>
				<NativeSelect.Option value="numeric">NUMERIC</NativeSelect.Option>
				<NativeSelect.Option value="text">TEXT</NativeSelect.Option>
			</NativeSelect.Root>
		</FormField>
		{#if tType === 'numeric'}
			<FormField label="Min" for="test-min" class="w-20">
				<Input id="test-min" type="number" step="any" bind:value={tMin} />
			</FormField>
			<FormField label="Max" for="test-max" class="w-20">
				<Input id="test-max" type="number" step="any" bind:value={tMax} />
			</FormField>
			<FormField label="Unit" for="test-unit" class="w-20">
				<Input id="test-unit" bind:value={tUnit} />
			</FormField>
		{/if}
		<div class="flex items-center gap-2 pb-2">
			<Checkbox id="test-required" bind:checked={tRequired} />
			<Label for="test-required" class="label">Required</Label>
		</div>
		<Button type="submit" size="sm" disabled={busy}>ADD</Button>
	</form>
{/snippet}

{#if detail.tests.length}
	<Section title="Tests" count={detail.tests.length}>
		{#snippet actions()}
			<ActionLink onclick={() => (addingTest = !addingTest)}
				>{addingTest ? 'CANCEL' : '+ ADD'}</ActionLink
			>
		{/snippet}
		<DataTable rows={detail.tests} columns={testColumns} key={(t) => t.id} emptyLabel="TESTS">
			{#snippet cell(t, col)}
				{#if col.key === 'name'}
					{t.name}{#if t.required}<span class="label ml-2">Required</span>{/if}
				{:else if col.key === 'type'}
					<span class="font-mono text-xs text-muted-foreground">{stateLabel(t.test_type)}</span>
				{:else if col.key === 'range'}
					{@const r = range(t)}
					{#if r}{r}{:else}<span class="text-muted-foreground">—</span>{/if}
				{:else}
					<ActionLink danger onclick={() => removeTest(t)}>DELETE</ActionLink>
				{/if}
			{/snippet}
		</DataTable>
		{#if addingTest}{@render testForm()}{/if}
	</Section>
{:else}
	<div>
		<EmptyLine label="TESTS" onadd={() => (addingTest = true)} />
		{#if addingTest}{@render testForm()}{/if}
	</div>
{/if}
