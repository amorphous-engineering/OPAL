<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { SvelteMap } from 'svelte/reactivity';
	import { api } from '#lib/api.js';
	import {
		PageHeader,
		Section,
		DataTable,
		DetailTable,
		DetailRow,
		State,
		Timestamp,
		confirm,
		toast,
		toastError
	} from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import WorkcenterForm from '#lib/components/workcenters/WorkcenterForm.svelte';
	import type { WorkcenterInput } from '#lib/components/workcenters/types.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const wc = $derived(data.workcenter);
	const work = $derived(data.work);
	// One row per procedure; the steps are listed by number.
	const byProcedure = $derived.by(() => {
		const m = new SvelteMap<
			number,
			{ procedure_id: number; procedure_name: string; status: string; steps: string[] }
		>();
		for (const s of work.default_steps) {
			const g = m.get(s.procedure_id) ?? {
				procedure_id: s.procedure_id,
				procedure_name: s.procedure_name,
				status: s.procedure_status,
				steps: []
			};
			g.steps.push(s.step_number);
			m.set(s.procedure_id, g);
		}
		return [...m.values()];
	});

	let editOpen = $state(false);
	let busy = $state(false);
	let error = $state<string | null>(null);

	async function save(v: WorkcenterInput) {
		busy = true;
		error = null;
		try {
			await api.patch(`/workcenters/${wc.id}`, v);
			editOpen = false;
			await invalidateAll();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to save';
			toastError(e);
		} finally {
			busy = false;
		}
	}

	async function setActive(active: boolean) {
		if (
			!active &&
			!(await confirm({
				title: `Deactivate ${wc.code}`,
				body: 'It no longer appears in workcenter pickers. Steps already assigned to it keep it.',
				action: 'DEACTIVATE',
				destructive: true
			}))
		)
			return;
		try {
			await api.patch(`/workcenters/${wc.id}`, { is_active: active });
			toast.success(active ? 'Workcenter activated' : 'Workcenter deactivated');
			await invalidateAll();
		} catch (e) {
			toastError(e);
		}
	}
</script>

<PageHeader
	title={wc.name}
	identifier={wc.code}
	crumbs={[{ label: 'Workcenters', href: '/workcenters' }, { label: wc.code }]}
>
	{#snippet state()}
		{#if !wc.is_active}<State value="inactive" tone="muted" badge />{/if}
	{/snippet}
	{#snippet actions()}
		<Button size="sm" variant="outline" onclick={() => (editOpen = true)}>EDIT</Button>
		{#if wc.is_active}
			<Button size="sm" variant="outline" onclick={() => setActive(false)}>DEACTIVATE</Button>
		{:else}
			<Button size="sm" variant="outline" onclick={() => setActive(true)}>ACTIVATE</Button>
		{/if}
	{/snippet}
</PageHeader>

<div class="grid grid-cols-1 gap-4 p-4">
	<Section title="Workcenter" class="max-w-3xl">
		<DetailTable>
			<DetailRow label="Code" value={wc.code} mono />
			<DetailRow label="Name" value={wc.name} />
			<DetailRow label="Location" value={wc.location} />
			<DetailRow label="Description">
				{#if wc.description}<span class="whitespace-pre-wrap">{wc.description}</span>
				{:else}<span class="text-muted-foreground">—</span>{/if}
			</DetailRow>
		</DetailTable>
	</Section>

	<Section title="Queue" count={work.queue.length}>
		<DataTable
			rows={work.queue}
			columns={[
				{ key: 'wo', label: 'Execution', width: '10rem' },
				{ key: 'procedure', label: 'Procedure' },
				{ key: 'step', label: 'Step' },
				{ key: 'step_status', label: 'Step state', width: '9rem' },
				{ key: 'due', label: 'Due', width: '9rem' }
			]}
			href={(r) => `/executions/${r.instance_id}`}
			emptyLabel="Queue"
			key={(r) => `${r.instance_id}:${r.step_number_str}`}
			dense
		>
			{#snippet cell(row, col)}
				{#if col.key === 'wo'}
					<span class="font-mono text-info">{row.work_order_number ?? 'Execution'}</span>
				{:else if col.key === 'procedure'}
					{row.procedure_name}
				{:else if col.key === 'step'}
					<span class="font-mono text-xs">{row.step_number_str}</span>
					{row.step_title ?? ''}
				{:else if col.key === 'step_status'}
					{#if row.step_status !== 'pending'}<State value={row.step_status} />
					{:else}<span class="text-muted-foreground">—</span>{/if}
				{:else}
					<Timestamp value={row.target_completion_at} dateOnly />
				{/if}
			{/snippet}
		</DataTable>
	</Section>

	<Section title="Default steps" count={work.default_steps.length}>
		<DataTable
			rows={byProcedure}
			columns={[
				{ key: 'procedure', label: 'Procedure' },
				{ key: 'steps', label: 'Steps' }
			]}
			href={(r) => `/procedures/${r.procedure_id}`}
			emptyLabel="Default steps"
			key={(r) => r.procedure_id}
			dense
		>
			{#snippet cell(row, col)}
				{#if col.key === 'procedure'}
					{row.procedure_name}
					{#if row.status !== 'active'}
						<State value={row.status} />
					{/if}
				{:else}
					<span class="font-mono text-xs break-words">{row.steps.join('  ')}</span>
				{/if}
			{/snippet}
		</DataTable>
	</Section>
</div>

<Dialog.Root bind:open={editOpen}>
	<Dialog.Content class="max-w-md">
		<Dialog.Header><Dialog.Title>Edit {wc.code}</Dialog.Title></Dialog.Header>
		{#key editOpen}
			<WorkcenterForm initial={wc} submitLabel="SAVE" {busy} {error} onsubmit={save}>
				{#snippet cancel()}
					<Button type="button" variant="outline" onclick={() => (editOpen = false)}>CANCEL</Button>
				{/snippet}
			</WorkcenterForm>
		{/key}
	</Dialog.Content>
</Dialog.Root>
