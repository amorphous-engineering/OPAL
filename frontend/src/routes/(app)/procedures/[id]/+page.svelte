<script lang="ts">
	import { goto, refreshAll } from '$app/navigation';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import { opal } from '#lib/api.js';
	import { PageHeader, State, confirm, toast, toastError } from '#lib/components/opal/index.js';
	import CloneDialog from '#lib/components/procedures/CloneDialog.svelte';
	import DetailsDialog from '#lib/components/procedures/DetailsDialog.svelte';
	import PublishDialog from '#lib/components/procedures/PublishDialog.svelte';
	import TemplateView from '#lib/components/procedures/TemplateView.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const p = $derived(data.procedure);
	const currentVersion = $derived(data.versions.find((v) => v.id === p.currentVersionId));
	const nextVersion = $derived((data.versions[0]?.versionNumber ?? 0) + 1);
	const startable = $derived(p.status === 'released' && !!p.currentVersionId);
	// The editor changes the draft under the loaded page: it reports sizes, and the
	// draft-vs-published state is re-read from the API after edits settle.
	let live = $state<{ unpublished: boolean | null; ops: number; steps: number } | null>(null);
	let liveFor = 0;
	$effect(() => {
		// A reload of the page data is authoritative again.
		void data.procedure;
		live = null;
	});
	const unpublished = $derived(live ? live.unpublished : p.unpublishedChanges);
	const templateNumber = $derived(p.templateNumber);

	let refreshTimer: ReturnType<typeof setTimeout> | undefined;
	function draftChanged(counts: { ops: number; steps: number }) {
		clearTimeout(refreshTimer);
		const ticket = ++liveFor;
		refreshTimer = setTimeout(async () => {
			try {
				const fresh = await opal.procedures.get({ id: p.id });
				if (ticket === liveFor)
					live = { unpublished: fresh.unpublishedChanges, ops: counts.ops, steps: counts.steps };
			} catch {
				/* the next change re-reads it */
			}
		}, 300);
	}

	let publishing = $state(false);
	let editing = $state(false);
	let cloning = $state(false);

	const reload = () => refreshAll();

	async function setStatus(status: 'released' | 'obsolete') {
		if (status === 'obsolete') {
			const ok = await confirm({
				title: 'Mark this template obsolete?',
				body: 'No new work orders can be cut from it. Existing work orders continue.',
				action: 'OBSOLETE'
			});
			if (!ok) return;
		}
		try {
			await opal.procedures.update({ id: p.id, status });
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
				{#if startable}
					<Button href={`/executions/new?procedure_id=${p.id}`}>START EXECUTION</Button>
				{/if}
				{#if unpublished !== false}
					<Button onclick={() => (publishing = true)}>PUBLISH v{nextVersion}</Button>
				{/if}
				{#if p.status === 'released'}
					<Button variant="outline" onclick={() => setStatus('obsolete')}>OBSOLETE</Button>
				{:else if p.status === 'obsolete'}
					<Button variant="outline" onclick={() => setStatus('released')}>RELEASE</Button>
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
	</div>
	{#key `${p.id}:${p.updatedAt}`}
		<TemplateView {data} {unpublished} {startable} onchange={draftChanged} onreload={reload} />
	{/key}
</div>

<PublishDialog
	bind:open={publishing}
	procedureId={p.id}
	{nextVersion}
	unchanged={unpublished === false}
	onpublished={reload}
/>
<DetailsDialog
	bind:open={editing}
	procedureId={p.id}
	name={p.name}
	description={p.description}
	type={p.procedureType}
	projectId={p.projectId}
	onsaved={reload}
/>
<CloneDialog bind:open={cloning} procedureId={p.id} name={p.name} />
