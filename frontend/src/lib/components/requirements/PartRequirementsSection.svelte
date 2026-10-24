<script lang="ts">
	// Requirements allocated to a part. Always relevant: empty is one line with the add action.
	import {
		ActionLink,
		DataTable,
		EmptyLine,
		Section,
		State,
		confirm,
		toast,
		toastError,
		type Column
	} from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { invalidateAll } from '$app/navigation';
	import { opal } from '#lib/api.js';
	import { stateLabel } from '#lib/format.js';
	import type { RequirementPartRequirement as Link } from '@opal/shared';
	import FormField from '../parts/FormField.svelte';

	let { partId, partNumber, version }: { partId: number; partNumber: string; version?: string } =
		$props();

	let rows = $state<Link[]>([]);
	let loaded = $state(false);
	let adding = $state(false);
	let reqNumber = $state('');
	let busy = $state(false);

	async function reload() {
		try {
			rows = await opal.requirements.forPart({ partId });
		} catch (e) {
			toastError(e);
		}
		loaded = true;
	}

	$effect(() => {
		void version;
		void partId;
		reload();
	});

	async function run(fn: () => Promise<unknown>, success: string): Promise<boolean> {
		busy = true;
		try {
			await fn();
			await reload();
			await invalidateAll();
			toast.success(success);
			return true;
		} catch (e) {
			toastError(e);
			return false;
		} finally {
			busy = false;
		}
	}

	async function assign(e: SubmitEvent) {
		e.preventDefault();
		if (await run(() => opal.requirements.assign({ partId, reqNumber }), 'Requirement allocated')) {
			reqNumber = '';
			adding = false;
		}
	}

	async function unassign(r: Link) {
		const ok = await confirm({
			title: `Remove ${r.reqNumber} from ${partNumber}`,
			body: 'The allocation and its verification status are deleted. The requirement itself is unchanged.',
			action: 'REMOVE',
			destructive: true
		});
		if (ok) await run(() => opal.requirements.unassign({ id: r.id }), 'Allocation removed');
	}

	const verify = (r: Link) =>
		run(() => opal.requirements.verifyLink({ id: r.id }), `${r.reqNumber} verified`);

	const flags = $derived({
		tbd: rows.filter((r) => r.tbd).length,
		tbr: rows.filter((r) => r.tbr).length,
		stale: rows.filter((r) => r.stale).length
	});

	const columns: Column<Link>[] = [
		{ key: 'reqNumber', label: 'Req', width: '7rem', mono: true },
		{ key: 'title', label: 'Title' },
		{ key: 'state', label: 'State', width: '6.5rem' },
		{ key: 'status', label: 'Allocation', width: '7rem' },
		{ key: 'actions', label: '', width: '8rem', align: 'right' }
	];
</script>

{#snippet form()}
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

<!-- added by requirements -->
{#if !loaded}
	<!-- first load -->
{:else if rows.length}
	<Section
		title="Requirements"
		count={[
			rows.length,
			flags.tbd ? `${flags.tbd} TBD` : '',
			flags.tbr ? `${flags.tbr} TBR` : '',
			flags.stale ? `${flags.stale} STALE` : ''
		]
			.filter(Boolean)
			.join(' · ')}
	>
		{#snippet actions()}
			<ActionLink onclick={() => (adding = !adding)}>{adding ? 'CANCEL' : '+ ADD'}</ActionLink>
		{/snippet}
		<DataTable
			{rows}
			{columns}
			key={(r) => r.id}
			href={(r) => `/requirements/${r.requirementId}`}
			emptyLabel="REQUIREMENTS"
		>
			{#snippet cell(r, col)}
				{#if col.key === 'reqNumber'}
					<a href={`/requirements/${r.requirementId}`} class="text-info hover:underline"
						>{r.reqNumber}</a
					>
				{:else if col.key === 'title'}
					{r.title}
					{#if r.tbd}<State value="tbd" tone="warn" label="TBD" class="ml-2" />{/if}
					{#if r.tbr}<State value="tbr" tone="warn" label="TBR" class="ml-2" />{/if}
					{#if r.stale}<State value="stale" tone="warn" label="STALE" class="ml-2" />{/if}
				{:else if col.key === 'state'}
					<span class="font-mono text-xs text-muted-foreground">{stateLabel(r.lifecycleState)}</span
					>
				{:else if col.key === 'status'}
					<State
						value={r.status}
						tone={r.status === 'verified' ? 'ok' : r.status === 'open' ? 'default' : 'muted'}
					/>
				{:else}
					<span class="flex justify-end gap-3">
						{#if r.status !== 'verified'}<ActionLink onclick={() => verify(r)}>VERIFY</ActionLink
							>{/if}
						<ActionLink danger onclick={() => unassign(r)}>REMOVE</ActionLink>
					</span>
				{/if}
			{/snippet}
		</DataTable>
		{#if adding}{@render form()}{/if}
	</Section>
{:else}
	<div>
		<EmptyLine label="REQUIREMENTS" onadd={() => (adding = true)} />
		{#if adding}{@render form()}{/if}
	</div>
{/if}
