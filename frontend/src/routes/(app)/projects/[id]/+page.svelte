<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import { opal } from '#lib/api.js';
	import {
		ActionLink,
		DataTable,
		DetailRow,
		DetailTable,
		EditToggle,
		ErrorBanner,
		MoreMenu,
		PageHeader,
		Section,
		State,
		Timestamp,
		askReason,
		isEditing,
		toast,
		toastError,
		type Column
	} from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { session } from '#lib/session.svelte.js';
	import { ticketLabel, ticketTone } from '#lib/components/issues/issues.js';
	import { lifecycleTone } from '#lib/components/requirements/lifecycle.js';
	import { dispositionTone } from '#lib/components/risks/types.js';
	import { stateLabel } from '#lib/format.js';
	import PluginPanels from '#lib/components/plugins/PluginPanels.svelte';
	import ExternalLinks from '#lib/components/plugins/ExternalLinks.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const project = $derived(data.project);
	const archived = $derived(project.state === 'archived');
	const editing = $derived(isEditing(page.url) && !archived);
	const isAdmin = $derived(!!session.user?.is_admin);

	let code = $state('');
	let name = $state('');
	let description = $state('');
	let busy = $state(false);
	let error = $state<string | null>(null);
	$effect(() => {
		if (editing) {
			code = project.code;
			name = project.name;
			description = project.description ?? '';
			error = null;
		}
	});

	async function save(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		error = null;
		try {
			await opal.org.projects.update({
				id: project.id,
				code: code.trim(),
				name: name.trim(),
				description: description.trim() || null
			});
			await invalidateAll();
			await goto(page.url.pathname);
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to save';
		} finally {
			busy = false;
		}
	}

	async function archive() {
		const reason = await askReason({
			title: `Archive ${project.code}`,
			body: 'An archived project keeps its records and takes no new ones. This cannot be undone.',
			action: 'ARCHIVE',
			destructive: true
		});
		if (reason === null) return;
		try {
			await opal.org.projects.archive({ id: project.id, reason });
			toast.success('Project archived');
			await invalidateAll();
		} catch (e) {
			toastError(e);
		}
	}

	/** "10+" when the list has more rows than it shows. */
	const countOf = (shown: number, next: string | null | undefined, total?: number) =>
		total ?? (next ? `${shown}+` : shown);

	const reqCols: Column<(typeof data.requirements.items)[number]>[] = [
		{ key: 'reqNumber', label: 'Number', mono: true, width: '8rem' },
		{ key: 'title', label: 'Title' },
		{ key: 'lifecycleState', label: 'State', width: '8rem' }
	];
	const riskCols: Column<(typeof data.risks.items)[number]>[] = [
		{ key: 'riskNumber', label: 'Risk', mono: true, width: '8rem' },
		{ key: 'title', label: 'Title' },
		{ key: 'disposition', label: 'Disposition', width: '8rem' },
		{ key: 'score', label: 'Score', mono: true, align: 'right', width: '5rem' }
	];
	const issueCols: Column<(typeof data.issues.items)[number]>[] = [
		{ key: 'issueNumber', label: 'Issue', mono: true, width: '8rem' },
		{ key: 'title', label: 'Title' },
		{ key: 'ticketState', label: 'State', width: '8rem' }
	];
	const procCols: Column<(typeof data.procedures.items)[number]>[] = [
		{ key: 'templateNumber', label: 'Template', mono: true, width: '8rem' },
		{ key: 'name', label: 'Name' },
		{ key: 'status', label: 'Status', width: '8rem' }
	];
	const dsCols: Column<(typeof data.datasets.items)[number]>[] = [
		{ key: 'name', label: 'Name' },
		{ key: 'pointCount', label: 'Points', mono: true, align: 'right', width: '6rem' },
		{ key: 'state', label: 'State', width: '8rem' }
	];
	const q = $derived(`projectId=${project.id}`);
</script>

<PageHeader
	title={project.name}
	identifier={project.code}
	crumbs={[{ label: 'Projects', href: '/projects' }, { label: project.code }]}
>
	{#snippet state()}
		{#if archived}<State value="archived" tone="warn" badge />{/if}
	{/snippet}
	{#snippet actions()}
		<Button size="sm" variant="ghost" href={`/audit?entity=project&record=${project.id}`}
			>AUDIT</Button
		>
		{#if !archived}<EditToggle />{/if}
		<MoreMenu
			items={[{ label: 'ARCHIVE', onselect: archive, strike: true, when: !archived && isAdmin }]}
		/>
	{/snippet}
</PageHeader>

<div class="grid grid-cols-[minmax(0,1fr)] gap-4 p-4">
	<Section title="Project">
		{#if editing}
			<form class="grid max-w-xl grid-cols-1 gap-3 p-3" onsubmit={save}>
				<div class="grid grid-cols-1 gap-1.5">
					<Label for="ep-code">Code</Label>
					<Input
						id="ep-code"
						class="w-40 font-mono uppercase"
						bind:value={code}
						maxlength={24}
						required
					/>
				</div>
				<div class="grid grid-cols-1 gap-1.5">
					<Label for="ep-name">Name</Label>
					<Input id="ep-name" bind:value={name} required />
				</div>
				<div class="grid grid-cols-1 gap-1.5">
					<Label for="ep-desc">Description</Label>
					<Textarea id="ep-desc" bind:value={description} rows={3} />
				</div>
				<ErrorBanner message={error} />
				<div class="flex gap-2">
					<Button type="submit" size="sm" disabled={busy || !code.trim() || !name.trim()}
						>SAVE</Button
					>
				</div>
			</form>
		{:else}
			<DetailTable>
				<DetailRow label="Code" mono value={project.code} />
				<DetailRow label="Name" value={project.name} />
				<DetailRow label="Description">
					{#if project.description}<span class="whitespace-pre-wrap">{project.description}</span
						>{:else}<span class="text-muted-foreground">—</span>{/if}
				</DetailRow>
				<DetailRow label="State" mono value={project.state.toUpperCase()} />
				<DetailRow label="Created"><Timestamp value={project.createdAt} /></DetailRow>
				<DetailRow label="Updated"><Timestamp value={project.updatedAt} /></DetailRow>
				{#if archived && project.archivedAt}
					<DetailRow label="Archived"><Timestamp value={project.archivedAt} /></DetailRow>
					<DetailRow label="Reason" value={project.archivedReason} />
				{/if}
			</DetailTable>
		{/if}
	</Section>

	<div class="grid grid-cols-1 items-start gap-4 xl:grid-cols-2">
		<Section
			title="Requirements"
			count={countOf(
				data.requirements.items.length,
				data.requirements.next,
				data.requirements.total
			)}
		>
			{#snippet actions()}
				<ActionLink href={`/requirements?project=${project.id}`}>ALL</ActionLink>
				{#if !archived}<ActionLink href={`/requirements/new?${q}`}>+ NEW</ActionLink>{/if}
			{/snippet}
			<DataTable
				rows={data.requirements.items}
				columns={reqCols}
				href={(r) => `/requirements/${r.id}`}
				key={(r) => r.id}
				emptyLabel="Requirements"
				dense
			>
				{#snippet cell(r, col)}
					{#if col.key === 'reqNumber'}
						<span class="text-info">{r.reqNumber}</span>
					{:else if col.key === 'lifecycleState'}
						<State value={r.lifecycleState} tone={lifecycleTone(r.lifecycleState)} />
					{:else}{r.title}{/if}
				{/snippet}
			</DataTable>
		</Section>

		<Section
			title="Risks"
			count={countOf(data.risks.items.length, data.risks.next, data.risks.total)}
		>
			{#snippet actions()}
				<ActionLink href={`/risks?project=${project.id}`}>ALL</ActionLink>
				{#if !archived}<ActionLink href={`/risks/new?${q}`}>+ NEW</ActionLink>{/if}
			{/snippet}
			<DataTable
				rows={data.risks.items}
				columns={riskCols}
				href={(r) => `/risks/${r.id}`}
				key={(r) => r.id}
				emptyLabel="Risks"
				dense
			>
				{#snippet cell(r, col)}
					{#if col.key === 'riskNumber'}
						<span class="text-info">{r.riskNumber}</span>
					{:else if col.key === 'disposition'}
						<State value={r.disposition} tone={dispositionTone(r.disposition)} />
					{:else if col.key === 'score'}{r.score}
					{:else}{r.title}{/if}
				{/snippet}
			</DataTable>
		</Section>

		<Section
			title="Issues"
			count={countOf(data.issues.items.length, data.issues.next, data.issues.total)}
		>
			{#snippet actions()}
				<ActionLink href={`/issues?project=${project.id}&state=all`}>ALL</ActionLink>
				{#if !archived}<ActionLink href={`/issues/new?${q}`}>+ NEW</ActionLink>{/if}
			{/snippet}
			<DataTable
				rows={data.issues.items}
				columns={issueCols}
				href={(r) => `/issues/${r.id}`}
				key={(r) => r.id}
				emptyLabel="Issues"
				dense
			>
				{#snippet cell(r, col)}
					{#if col.key === 'issueNumber'}
						<span class="text-info">{r.issueNumber}</span>
					{:else if col.key === 'ticketState'}
						<State
							value={r.ticketState}
							label={ticketLabel(r.ticketState)}
							tone={ticketTone(r.ticketState)}
						/>
					{:else}{r.title}{/if}
				{/snippet}
			</DataTable>
		</Section>

		<Section
			title="Procedures"
			count={countOf(data.procedures.items.length, data.procedures.next, data.procedures.total)}
		>
			{#snippet actions()}
				<ActionLink href={`/procedures?project=${project.id}`}>ALL</ActionLink>
				{#if !archived}<ActionLink href={`/procedures/new?${q}`}>+ NEW</ActionLink>{/if}
			{/snippet}
			<DataTable
				rows={data.procedures.items}
				columns={procCols}
				href={(r) => `/procedures/${r.id}`}
				key={(r) => r.id}
				emptyLabel="Procedures"
				dense
			>
				{#snippet cell(r, col)}
					{#if col.key === 'templateNumber'}
						<span class="text-info">{r.templateNumber}</span>
					{:else if col.key === 'status'}
						<span class="font-mono text-xs">{stateLabel(r.status)}</span>
					{:else}{r.name}{/if}
				{/snippet}
			</DataTable>
		</Section>

		{#if data.executions}
			<Section
				title="Executions"
				count={countOf(data.executions.items.length, data.executions.next, data.executions.total)}
			>
				{#snippet actions()}
					<ActionLink href={`/executions?project=${project.id}`}>ALL</ActionLink>
				{/snippet}
				<DataTable
					rows={data.executions.items}
					columns={[
						{ key: 'woNumber', label: 'Execution', mono: true, width: '8rem' }, // added by execution
						{ key: 'procedureName', label: 'Procedure' },
						{ key: 'status', label: 'Status', width: '8rem' }
					]}
					href={(r) => `/executions/${r.id}`}
					key={(r) => String(r.id)}
					emptyLabel="Executions"
					dense
				>
					{#snippet cell(r, col)}
						{#if col.key === 'woNumber'}
							<span class="text-info">{r.woNumber}</span>
						{:else if col.key === 'status'}
							<span class="font-mono text-xs">{stateLabel(r.status)}</span>
						{:else}{r.procedureName}{/if}
					{/snippet}
				</DataTable>
			</Section>
		{/if}

		<Section title="Datasets" count={countOf(data.datasets.items.length, data.datasets.next)}>
			{#snippet actions()}
				<ActionLink href={`/datasets?project=${project.id}`}>ALL</ActionLink>
				{#if !archived}<ActionLink href={`/datasets/new?${q}`}>+ NEW</ActionLink>{/if}
			{/snippet}
			<DataTable
				rows={data.datasets.items}
				columns={dsCols}
				href={(r) => `/datasets/${r.id}`}
				key={(r) => r.id}
				emptyLabel="Datasets"
				dense
			>
				{#snippet cell(r, col)}
					{#if col.key === 'pointCount'}{r.pointCount}
					{:else if col.key === 'state'}
						{#if r.state === 'archived'}<State value="archived" tone="warn" />{:else}<span
								class="font-mono text-xs text-muted-foreground">ACTIVE</span
							>{/if}
					{:else}{r.name}{/if}
				{/snippet}
			</DataTable>
		</Section>
	</div>

	<PluginPanels slot="project.side" recordId={project.id} number={project.code} />
	<ExternalLinks entityType="project" entityId={project.id} />
</div>
