<script lang="ts">
	import { goto, refreshAll } from '$app/navigation';
	import { page } from '$app/state';
	import { Button } from '#lib/components/ui/button/index.js';
	import { opal } from '#lib/api.js';
	import {
		EditToggle,
		MoreMenu,
		PageHeader,
		State,
		Timestamp,
		askReason,
		confirm,
		isEditing,
		toast,
		toastError
	} from '#lib/components/opal/index.js';
	import CloneDialog from '#lib/components/procedures/CloneDialog.svelte';
	import DetailsDialog from '#lib/components/procedures/DetailsDialog.svelte';
	import PublishDialog from '#lib/components/procedures/PublishDialog.svelte';
	import TemplateEditor from '#lib/components/procedures/TemplateEditor.svelte';
	import TemplateReader from '#lib/components/procedures/TemplateReader.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const p = $derived(data.procedure);
	const currentVersion = $derived(data.versions.find((v) => v.id === p.currentVersionId));
	const nextVersion = $derived((data.versions[0]?.versionNumber ?? 0) + 1);
	const startable = $derived(p.status === 'released' && !!p.currentVersionId);
	// The page opens for reading. EDIT (?edit=1) is the only way into the editor, and an
	// obsolete template has none: reinstating it is the way back.
	const editing = $derived(isEditing(page.url) && p.status !== 'obsolete');
	// The editor changes the draft under the loaded page: it reports sizes, and the
	// draft-vs-published state is re-read from the API after edits settle.
	let live = $state<{ unpublished: boolean | null } | null>(null);
	let liveFor = 0;
	$effect(() => {
		// A reload of the page data is authoritative again.
		void data.procedure;
		live = null;
	});
	const unpublished = $derived(live ? live.unpublished : p.unpublishedChanges);
	const templateNumber = $derived(p.templateNumber);

	let refreshTimer: ReturnType<typeof setTimeout> | undefined;
	function draftChanged() {
		clearTimeout(refreshTimer);
		const ticket = ++liveFor;
		refreshTimer = setTimeout(async () => {
			try {
				const fresh = await opal.procedures.get({ id: p.id });
				if (ticket === liveFor) live = { unpublished: fresh.unpublishedChanges };
			} catch {
				/* the next change re-reads it */
			}
		}, 300);
	}

	let publishing = $state(false);
	let editingDetails = $state(false);
	let cloning = $state(false);

	const reload = () => refreshAll();

	/** A published version is the commit: afterwards the page returns to reading it. */
	async function published() {
		await goto(`/procedures/${p.id}`, { invalidateAll: true });
	}

	async function obsolete() {
		const reason = await askReason({
			title: `Make ${templateNumber} obsolete?`,
			body: 'No new work orders can be cut from it. Work orders already cut continue.',
			action: 'OBSOLETE'
		});
		if (reason === null) return;
		try {
			await opal.procedures.obsolete({ id: p.id, reason });
			await reload();
		} catch (e) {
			toastError(e);
		}
	}

	async function reinstate() {
		const reason = await askReason({
			title: `Reinstate ${templateNumber}?`,
			body: 'New work orders can be cut from it again.',
			action: 'REINSTATE'
		});
		if (reason === null) return;
		try {
			await opal.procedures.reinstate({ id: p.id, reason });
			await reload();
		} catch (e) {
			toastError(e);
		}
	}

	async function remove() {
		const ok = await confirm({
			title: `Delete ${p.name}?`,
			body: 'The template and its draft are removed.',
			action: 'DELETE',
			destructive: true
		});
		if (!ok) return;
		try {
			await opal.procedures.delete({ id: p.id });
			toast.success('Template deleted');
			await goto('/procedures');
		} catch (e) {
			toastError(e);
		}
	}
</script>

<!-- On wide screens the page is locked to the viewport: the header stays put; only the
     document (or DETAILS) scrolls, between two fixed-height sidebars. -->
<div class="flex min-w-0 flex-col lg:h-[calc(100svh-var(--shell-h))]">
	<div class="shrink-0">
		<PageHeader
			title={p.name}
			identifier={templateNumber}
			crumbs={[{ label: 'Templates', href: '/procedures' }, { label: templateNumber }]}
		>
			{#snippet state()}
				{#if currentVersion}
					<span class="font-mono text-xs text-muted-foreground"
						>v{currentVersion.versionNumber}</span
					>
				{/if}
				<State
					value={p.status}
					tone={p.status === 'draft' ? 'warn' : p.status === 'obsolete' ? 'error' : 'ok'}
					badge={p.status !== 'released'}
				/>
			{/snippet}
			{#snippet actions()}
				{#if startable && !editing}
					<Button href={`/executions/new?procedure_id=${p.id}`}>START EXECUTION</Button>
				{/if}
				{#if editing && unpublished !== false}
					<Button onclick={() => (publishing = true)}>PUBLISH v{nextVersion}</Button>
				{/if}
				{#if editing}
					<Button variant="outline" onclick={() => (editingDetails = true)}>DETAILS</Button>
				{/if}
				{#if p.status !== 'obsolete'}
					<EditToggle label={p.status === 'released' ? 'EDIT DRAFT' : 'EDIT'} />
				{/if}
				<MoreMenu
					items={[
						{ label: 'CLONE', onselect: () => (cloning = true), when: p.status !== 'draft' },
						{ label: 'OBSOLETE', onselect: obsolete, strike: true, when: p.status === 'released' },
						{ label: 'REINSTATE', onselect: reinstate, when: p.status === 'obsolete' },
						{
							label: 'DELETE',
							onselect: remove,
							strike: true,
							when: data.versions.length === 0 && p.status === 'draft'
						}
					]}
				/>
			{/snippet}
		</PageHeader>
	</div>
	{#if p.status === 'obsolete'}
		<div
			class="flex shrink-0 flex-wrap items-baseline gap-x-3 border-b border-border bg-muted px-4 py-1.5 text-xs"
			role="status"
		>
			<span class="font-mono font-medium text-error">OBSOLETE</span>
			<Timestamp value={p.updatedAt} />
			<span class="min-w-0 [overflow-wrap:anywhere]">{p.statusReason ?? ''}</span>
		</div>
	{:else if editing}
		<div
			class="flex shrink-0 flex-wrap items-baseline gap-x-3 border-b border-warn/50 bg-warn-muted px-4 py-1.5 font-mono text-xs"
			role="status"
		>
			<span class="font-medium text-warn">DRAFT</span>
			{#if currentVersion}
				<span class="text-muted-foreground"
					>v{currentVersion.versionNumber} RELEASED · DRAFT {unpublished
						? 'DIFFERS'
						: 'MATCHES'}</span
				>
			{:else}
				<span class="text-muted-foreground">NEVER PUBLISHED</span>
			{/if}
		</div>
	{/if}
	{#if editing}
		{#key p.id}
			<TemplateEditor {data} {unpublished} {startable} onchange={draftChanged} onreload={reload} />
		{/key}
	{:else}
		{#key `${p.id}:${p.updatedAt}`}
			<TemplateReader {data} {unpublished} {startable} onreload={reload} />
		{/key}
	{/if}
</div>

<PublishDialog
	bind:open={publishing}
	procedureId={p.id}
	{nextVersion}
	unchanged={unpublished === false}
	onpublished={published}
/>
<DetailsDialog
	bind:open={editingDetails}
	procedureId={p.id}
	name={p.name}
	description={p.description}
	type={p.procedureType}
	projectId={p.projectId}
	onsaved={reload}
/>
<CloneDialog bind:open={cloning} procedureId={p.id} name={p.name} />
