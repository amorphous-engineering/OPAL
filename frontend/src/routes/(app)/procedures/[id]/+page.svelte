<script lang="ts">
	import { goto, refreshAll } from '$app/navigation';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import { api } from '#lib/api.js';
	import {
		DataTable,
		DetailRow,
		DetailTable,
		EmptyLine,
		PageHeader,
		Section,
		State,
		Timestamp,
		confirm,
		toast,
		toastError
	} from '#lib/components/opal/index.js';
	import type { Column } from '#lib/components/opal/index.js';
	import Prose from '#lib/components/procedures/Prose.svelte';
	import CloneDialog from '#lib/components/procedures/CloneDialog.svelte';
	import DetailsDialog from '#lib/components/procedures/DetailsDialog.svelte';
	import PartLines from '#lib/components/procedures/PartLines.svelte';
	import PublishDialog from '#lib/components/procedures/PublishDialog.svelte';
	import ReferenceDocs from '#lib/components/procedures/ReferenceDocs.svelte';
	import StepOutline from '#lib/components/procedures/StepOutline.svelte';
	import VersionsSection from '#lib/components/procedures/VersionsSection.svelte';
	import type { ExecutionRow, IssueRow } from '#lib/components/procedures/types.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const p = $derived(data.procedure);
	const currentVersion = $derived(data.versions.find((v) => v.id === p.current_version_id));
	const nextVersion = $derived((data.versions[0]?.version_number ?? 0) + 1);
	const startable = $derived(p.status === 'active' && !!p.current_version_id);
	const stepCount = $derived(p.steps.reduce((n, s) => n + 1 + s.sub_steps.length, 0));
	const showOutputs = $derived(p.procedure_type === 'build' || data.outputs.length > 0);

	let publishing = $state(false);
	let editing = $state(false);
	let cloning = $state(false);

	const reload = () => refreshAll();

	async function setStatus(status: 'active' | 'deprecated') {
		if (status === 'deprecated') {
			const ok = await confirm({
				title: 'Deprecate this template?',
				body: 'No new work orders can be cut from it. Existing work orders continue.',
				action: 'DEPRECATE'
			});
			if (!ok) return;
		}
		try {
			await api.patch(`/procedures/${p.id}`, { status });
			await reload();
		} catch (e) {
			toastError(e);
		}
	}

	async function remove() {
		const ok = await confirm({
			title: `Delete ${p.name}?`,
			body: 'The template and its draft are removed. Work orders already cut keep their published version.',
			action: 'DELETE',
			destructive: true
		});
		if (!ok) return;
		try {
			await api.del(`/procedures/${p.id}`);
			toast.success('Template deleted');
			await goto('/procedures');
		} catch (e) {
			toastError(e);
		}
	}

	const execColumns: Column<ExecutionRow>[] = [
		{ key: 'work_order_number', label: 'Work order', mono: true },
		{ key: 'version_number', label: 'Version', width: '6rem', mono: true },
		{ key: 'status', label: 'Status', width: '7rem' },
		{ key: 'created_at', label: 'Cut', width: '10rem' }
	];
	const issueColumns: Column<IssueRow>[] = [
		{ key: 'issue_number', label: 'Issue', width: '8rem', mono: true },
		{ key: 'title', label: 'Title' },
		{ key: 'priority', label: 'Priority', width: '6rem' },
		{ key: 'disp_state', label: 'Disposition', width: '9rem' }
	];
</script>

<PageHeader
	title={p.name}
	identifier={currentVersion ? `v${currentVersion.version_number}` : null}
	crumbs={[{ label: 'Templates', href: '/procedures' }, { label: p.name }]}
>
	{#snippet state()}<State value={p.status} badge={p.status !== 'active'} />{/snippet}
	{#snippet actions()}
		{#if startable}
			<Button href={`/executions/new?procedure_id=${p.id}`}>START EXECUTION</Button>
		{/if}
		<Button
			variant={startable && p.unpublished_changes === false ? 'outline' : 'default'}
			onclick={() => (publishing = true)}>PUBLISH v{nextVersion}</Button
		>
		{#if p.status === 'active'}
			<Button variant="outline" onclick={() => setStatus('deprecated')}>DEPRECATE</Button>
		{:else if p.status === 'deprecated'}
			<Button variant="outline" onclick={() => setStatus('active')}>ACTIVATE</Button>
		{/if}
		<DropdownMenu.Root>
			<DropdownMenu.Trigger>
				{#snippet child({ props })}
					<Button variant="outline" {...props} aria-label="More actions">MORE</Button>
				{/snippet}
			</DropdownMenu.Trigger>
			<DropdownMenu.Content align="end" class="w-44">
				<DropdownMenu.Item onSelect={() => (editing = true)}>Edit details</DropdownMenu.Item>
				<DropdownMenu.Item onSelect={() => (cloning = true)}>Clone</DropdownMenu.Item>
				<DropdownMenu.Separator />
				<DropdownMenu.Item class="text-destructive" onSelect={remove}>Delete</DropdownMenu.Item>
			</DropdownMenu.Content>
		</DropdownMenu.Root>
	{/snippet}
</PageHeader>

<div class="grid items-start gap-4 p-4 xl:grid-cols-2">
	<div class="grid min-w-0 gap-4">
		<Section title="Details">
			<DetailTable>
				<DetailRow label="Type" value={p.procedure_type.toUpperCase()} mono />
				<DetailRow label="Current version">
					{#if currentVersion}
						<a
							href={`/procedures/versions/${currentVersion.id}`}
							class="font-mono text-info hover:underline">v{currentVersion.version_number}</a
						>
					{:else}—{/if}
				</DetailRow>
				<DetailRow label="Draft">
					{#if p.unpublished_changes === null}
						<span class="font-mono text-xs text-muted-foreground">NEVER PUBLISHED</span>
					{:else if p.unpublished_changes}
						<span class="font-mono text-xs text-warn"
							>CHANGED SINCE v{currentVersion?.version_number}</span
						>
					{:else}
						<span class="font-mono text-xs text-muted-foreground"
							>MATCHES v{currentVersion?.version_number}</span
						>
					{/if}
				</DetailRow>
				<DetailRow
					label="Steps"
					value={`${p.steps.length} ops · ${stepCount - p.steps.length} steps`}
					mono
				/>
				<DetailRow label="Created"><Timestamp value={p.created_at} /></DetailRow>
				<DetailRow label="Updated"><Timestamp value={p.updated_at} /></DetailRow>
				<DetailRow label="Description">
					{#if p.description}
						<Prose source={p.description} />
					{:else}—{/if}
				</DetailRow>
			</DetailTable>
		</Section>

		<!-- The step editor replaces StepOutline; the rest of this page stays. -->
		<StepOutline steps={p.steps} onchange={reload} />
	</div>

	<div class="grid min-w-0 gap-4">
		{#if data.executions.total === 0}
			{#if startable}
				<EmptyLine label="Executions">
					{#snippet action()}
						<a
							href={`/executions/new?procedure_id=${p.id}`}
							class="font-medium text-info hover:underline">+ START</a
						>
					{/snippet}
				</EmptyLine>
			{:else}
				<EmptyLine label="Executions" />
			{/if}
		{:else}
			<Section title="Executions" count={data.executions.total}>
				{#snippet actions()}
					{#if data.executions.total > data.executions.items.length}
						<Button variant="ghost" size="xs" href={`/executions?procedure=${p.id}&status=all`}
							>ALL →</Button
						>
					{/if}
				{/snippet}
				<DataTable
					rows={data.executions.items}
					columns={execColumns}
					emptyLabel="Executions"
					dense
					key={(r) => r.id}
					href={(r) => `/executions/${r.id}`}
				>
					{#snippet cell(r, col)}
						{#if col.key === 'work_order_number'}
							<a href={`/executions/${r.id}`} class="text-info hover:underline"
								>{r.work_order_number ?? '—'}</a
							>
						{:else if col.key === 'version_number'}
							v{r.version_number}
						{:else if col.key === 'status'}
							<State value={r.status} />
						{:else if col.key === 'created_at'}
							<Timestamp value={r.created_at} />
						{/if}
					{/snippet}
				</DataTable>
			</Section>
		{/if}

		{#if data.issues.total === 0}
			<EmptyLine label="Open issues" />
		{:else}
			<Section title="Open issues" count={data.issues.total}>
				{#snippet actions()}
					{#if data.issues.total > data.issues.items.length}
						<Button variant="ghost" size="xs" href={`/issues?procedure=${p.id}&status=open`}
							>ALL →</Button
						>
					{/if}
				{/snippet}
				<DataTable
					rows={data.issues.items}
					columns={issueColumns}
					emptyLabel="Open issues"
					dense
					key={(r) => r.id}
					href={(r) => `/issues/${r.id}`}
				>
					{#snippet cell(r, col)}
						{#if col.key === 'issue_number'}
							<a href={`/issues/${r.id}`} class="text-info hover:underline"
								>{r.issue_number ?? '—'}</a
							>
						{:else if col.key === 'priority'}
							<State value={r.priority} />
						{:else if col.key === 'disp_state'}
							<State value={r.disp_state} />
						{:else}
							{(r as unknown as Record<string, unknown>)[col.key]}
						{/if}
					{/snippet}
				</DataTable>
			</Section>
		{/if}

		<VersionsSection
			procedureId={p.id}
			versions={data.versions}
			currentVersionId={p.current_version_id}
		/>
		<ReferenceDocs procedureId={p.id} docs={data.docs} onchange={reload} />
	</div>
</div>

<div class="grid gap-4 px-4 pb-4">
	<PartLines kind="kit" procedureId={p.id} lines={data.kit} onchange={reload} />
	{#if showOutputs}
		<PartLines kind="outputs" procedureId={p.id} lines={data.outputs} onchange={reload} />
	{/if}
</div>

<PublishDialog
	bind:open={publishing}
	procedureId={p.id}
	{nextVersion}
	unchanged={p.unpublished_changes === false}
	onpublished={reload}
/>
<DetailsDialog
	bind:open={editing}
	procedureId={p.id}
	name={p.name}
	description={p.description}
	type={p.procedure_type}
	onsaved={reload}
/>
<CloneDialog bind:open={cloning} procedureId={p.id} name={p.name} />
