<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import { SvelteMap } from 'svelte/reactivity';
	import { opal } from '#lib/api.js';
	import {
		PageHeader,
		Section,
		DataTable,
		DetailTable,
		DetailRow,
		EditToggle,
		MoreMenu,
		State,
		Timestamp,
		confirm,
		isEditing,
		toast,
		toastError
	} from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
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
			{ procedureId: number; procedureName: string; status: string; steps: string[] }
		>();
		for (const s of work.defaultSteps) {
			const g = m.get(s.procedureId) ?? {
				procedureId: s.procedureId,
				procedureName: s.procedureName,
				status: s.procedureStatus,
				steps: []
			};
			g.steps.push(s.stepNumber);
			m.set(s.procedureId, g);
		}
		return [...m.values()];
	});

	const editing = $derived(isEditing(page.url));
	let busy = $state(false);
	let error = $state<string | null>(null);

	async function save(v: WorkcenterInput) {
		busy = true;
		error = null;
		try {
			await opal.org.workcenters.update({ id: wc.id, ...v });
			await invalidateAll();
			await goto(page.url.pathname);
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
			await opal.org.workcenters.update({ id: wc.id, isActive: active });
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
		{#if !wc.isActive}<State value="inactive" tone="muted" badge />{/if}
	{/snippet}
	{#snippet actions()}
		<EditToggle />
		<MoreMenu
			items={[
				{ label: 'DEACTIVATE', onselect: () => setActive(false), strike: true, when: wc.isActive },
				{ label: 'ACTIVATE', onselect: () => setActive(true), when: !wc.isActive }
			]}
		/>
	{/snippet}
</PageHeader>

<div class="grid grid-cols-1 gap-4 p-4">
	<Section title="Workcenter" class="max-w-3xl">
		{#if editing}
			<div class="p-3">
				{#key wc.id}
					<WorkcenterForm
						initial={wc}
						submitLabel="SAVE"
						showActive={false}
						{busy}
						{error}
						onsubmit={save}
					>
						{#snippet cancel()}{/snippet}
					</WorkcenterForm>
				{/key}
			</div>
		{:else}
			<DetailTable>
				<DetailRow label="Code" value={wc.code} mono />
				<DetailRow label="Name" value={wc.name} />
				<DetailRow label="Location" value={wc.location} />
				<DetailRow label="Description">
					{#if wc.description}<span class="whitespace-pre-wrap">{wc.description}</span>
					{:else}<span class="text-muted-foreground">—</span>{/if}
				</DetailRow>
			</DetailTable>
		{/if}
	</Section>

	<Section title="Queue" count={work.queue.length}>
		<DataTable
			rows={work.queue}
			columns={[
				{ key: 'wo', label: 'Execution', width: '10rem' },
				{ key: 'procedure', label: 'Procedure' },
				{ key: 'step', label: 'Step' },
				{ key: 'stepStatus', label: 'Step state', width: '9rem' },
				{ key: 'due', label: 'Due', width: '9rem' }
			]}
			href={(r) => `/executions/${r.instanceId}`}
			emptyLabel="Queue"
			key={(r) => `${r.instanceId}:${r.stepNumberStr}`}
			dense
		>
			{#snippet cell(row, col)}
				{#if col.key === 'wo'}
					<span class="font-mono text-info">{row.workOrderNumber ?? 'Execution'}</span>
				{:else if col.key === 'procedure'}
					{row.procedureName}
				{:else if col.key === 'step'}
					<span class="font-mono text-xs">{row.stepNumberStr}</span>
					{row.stepTitle ?? ''}
				{:else if col.key === 'stepStatus'}
					{#if row.stepStatus !== 'pending'}<State value={row.stepStatus} />
					{:else}<span class="text-muted-foreground">—</span>{/if}
				{:else}
					<Timestamp value={row.targetCompletionAt} dateOnly />
				{/if}
			{/snippet}
		</DataTable>
	</Section>

	<Section title="Default steps" count={work.defaultSteps.length}>
		<DataTable
			rows={byProcedure}
			columns={[
				{ key: 'procedure', label: 'Procedure' },
				{ key: 'steps', label: 'Steps' }
			]}
			href={(r) => `/procedures/${r.procedureId}`}
			emptyLabel="Default steps"
			key={(r) => r.procedureId}
			dense
		>
			{#snippet cell(row, col)}
				{#if col.key === 'procedure'}
					{row.procedureName}
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
