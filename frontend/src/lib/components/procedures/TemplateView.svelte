<script lang="ts">
	// The template page body in the execution page's shape: OP index and facts on the
	// left, the editable document (or DETAILS) in the centre, the surrounding record on
	// the right. On wide screens only the centre scrolls. Owns the AuthorStore.
	import { onMount, tick, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { Button } from '#lib/components/ui/button/index.js';
	import { cn } from '#lib/utils.js';
	import { ProcedureDocument } from '#lib/components/procedure-doc/index.js';
	import { AuthorStore } from '#lib/authoring/store.svelte.js';
	import { PreviewController } from '#lib/authoring/preview.svelte.js';
	import { ErrorBanner, TabStrip, Timestamp } from '#lib/components/opal/index.js';
	import TemplateGraph from './TemplateGraph.svelte';
	import TemplateDetails from './TemplateDetails.svelte';
	import TemplateNav from './TemplateNav.svelte';
	import TemplateSide from './TemplateSide.svelte';
	import type { TemplateData } from './template-data.js';

	let {
		data,
		unpublished,
		startable,
		onchange,
		onreload
	}: {
		data: TemplateData;
		unpublished: boolean | null;
		startable: boolean;
		onchange?: (counts: { ops: number; steps: number }) => void;
		onreload: () => void | Promise<void>;
	} = $props();

	// svelte-ignore state_referenced_locally
	const store = new AuthorStore(data.procedure.id, () => onchange?.(store.counts));
	const preview = new PreviewController();
	let previewing = $state(false);

	onMount(() => {
		store.start();
		return () => store.stop();
	});

	// Report the size of the template to the page once it is known and when it changes.
	$effect(() => {
		const c = store.counts;
		untrack(() => onchange?.(c));
	});

	const doc = $derived(store.doc);
	const total = $derived(store.counts.ops + store.counts.steps);
	const status = $derived(store.status);
	const shown = $derived(store.shownOps);

	const tabs = [
		{ id: 'document', label: 'Document' },
		{ id: 'graph', label: 'Graph' },
		{ id: 'details', label: 'Details' }
	];
	const tab = $derived(
		tabs.find((t) => t.id === page.url.searchParams.get('tab'))?.id ?? 'document'
	);

	function setTab(value: string) {
		const url = new URL(page.url.href);
		if (value === 'document') url.searchParams.delete('tab');
		else url.searchParams.set('tab', value);
		return goto(url, { replace: true, reset: false });
	}

	/** Jump to a row in the document, switching to the document tab first. */
	async function jump(order: number) {
		if (tab !== 'document') {
			await setTab('document');
			await tick();
		}
		store.jumpTo(order);
	}

	function onKey(e: KeyboardEvent) {
		if (tab !== 'document') return;
		const t = e.target as HTMLElement | null;
		const typing =
			!!t && (['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || t.isContentEditable);
		if (!typing && !e.metaKey && !e.ctrlKey && !e.altKey && e.key === 'p') {
			e.preventDefault();
			previewing = !previewing;
			return;
		}
		if (!previewing) store.handleKey(e);
	}

	const barButton =
		'px-3 font-mono text-xs font-medium tracking-wider uppercase outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset';
</script>

<svelte:window onkeydown={onKey} />

<div
	class="grid min-h-0 flex-1 grid-cols-1 items-start gap-4 p-4 lg:grid-cols-[fit-content(20%)_minmax(0,1fr)_fit-content(20%)] lg:grid-rows-[minmax(0,1fr)] lg:items-stretch lg:pb-0"
>
	<aside
		class="min-w-0 overflow-x-hidden lg:h-full lg:min-h-0 lg:overflow-y-hidden lg:pb-4"
		aria-label="Operations"
	>
		<TemplateNav {store} {data} {unpublished} onjump={jump} />
	</aside>
	<div class={cn('flex min-h-0 min-w-0 flex-col', tab === 'document' ? 'gap-0' : 'gap-3')}>
		{#if store.stale}
			<div
				class="mb-3 flex shrink-0 items-center gap-3 rounded-lg border border-warn/50 bg-warn-muted px-3 py-1.5 text-xs"
				role="status"
			>
				<span class="font-mono text-warn">CHANGED ELSEWHERE</span>
				<Button size="xs" variant="outline" onclick={() => store.refreshFromServer()}
					>REFRESH</Button
				>
			</div>
		{/if}
		<TabStrip
			{tabs}
			value={tab}
			onchange={setTab}
			class={cn('shrink-0', tab === 'document' && 'rounded-b-none')}
		>
			{#snippet end()}
				{#if tab === 'document'}
					{#if status !== 'idle' || store.savedAt}
						<span
							class={cn(
								'flex items-center px-3 font-mono text-xs',
								status === 'error' && 'text-error',
								(status === 'saving' || status === 'dirty') && 'text-warn',
								(status === 'saved' || status === 'idle') && 'text-muted-foreground'
							)}
							role="status"
							aria-live="polite"
							data-save-status={status}
						>
							{#if status === 'error'}
								NOT SAVED · <button
									type="button"
									class="ml-1 underline"
									onclick={() => store.retry()}>RETRY</button
								>
							{:else if status === 'saving' || status === 'dirty'}
								SAVING
							{:else if store.savedAt}
								SAVED&nbsp;<Timestamp value={new Date(store.savedAt).toISOString()} />
							{/if}
						</span>
					{/if}
					{#if !previewing}
						<button
							type="button"
							class={cn(
								barButton,
								'border-l border-border text-muted-foreground hover:text-foreground max-sm:hidden'
							)}
							onclick={() => store.setAllOpen(true)}>Expand all</button
						>
						<button
							type="button"
							class={cn(
								barButton,
								'border-l border-border text-muted-foreground hover:text-foreground max-sm:hidden'
							)}
							onclick={() => store.setAllOpen(false)}>Collapse all</button
						>
					{/if}
					{@render viewToggle()}
					<button
						type="button"
						class={cn(
							barButton,
							'border-l border-border',
							store.focusMode ? 'bg-card text-info' : 'text-muted-foreground hover:text-foreground'
						)}
						aria-pressed={store.focusMode}
						title="Show only the operation selected in the sidebar"
						onclick={() => store.setFocusMode(!store.focusMode)}>Focus</button
					>
				{:else if tab === 'graph'}
					{@render viewToggle()}
				{/if}
			{/snippet}
		</TabStrip>
		{#snippet viewToggle()}
			<span class="flex items-stretch border-l border-border" role="group" aria-label="View">
				<button
					type="button"
					class={cn(
						barButton,
						!previewing ? 'bg-card text-info' : 'text-muted-foreground hover:text-foreground'
					)}
					aria-pressed={!previewing}
					onclick={() => (previewing = false)}>Edit</button
				>
				<button
					type="button"
					class={cn(
						barButton,
						'border-l border-border',
						previewing ? 'bg-card text-info' : 'text-muted-foreground hover:text-foreground'
					)}
					aria-pressed={previewing}
					title="The document as an operator sees it (p)"
					onclick={() => (previewing = true)}>Preview</button
				>
			</span>
		{/snippet}
		<div
			id="exec-scroll"
			class={cn(
				'min-h-0 min-w-0 flex-1 lg:pb-4 [&_[data-doc-mode]>section:first-of-type]:rounded-t-none [&_[data-doc-mode]>section:first-of-type]:border-t-0',
				tab === 'graph' ? 'min-h-80 lg:overflow-hidden' : 'lg:overflow-y-auto'
			)}
		>
			{#if tab === 'details'}
				<TemplateDetails {data} onchange={onreload} />
			{:else if tab === 'graph'}
				{#if store.loading}
					<div class="h-24 animate-pulse bg-muted"></div>
				{:else if store.error}
					<ErrorBanner message={store.error} />
				{:else}
					<TemplateGraph {store} editable={!previewing} onopen={jump} />
				{/if}
			{:else if store.loading}
				<div class="mt-3 h-24 animate-pulse bg-muted"></div>
			{:else if store.error}
				<ErrorBanner message={store.error} class="mt-3" />
			{:else}
				{@const ops = doc.ops.filter((o) => shown.includes(o))}
				{@const contingency = doc.contingency.filter((o) => shown.includes(o))}
				{#if previewing}
					<ProcedureDocument controller={preview} {ops} {contingency} />
				{:else}
					<ProcedureDocument controller={store} {ops} {contingency} />
					{#if total > 0}
						<p class="mt-2 font-mono text-xs text-muted-foreground">
							J/K MOVE · ENTER EDIT TITLE · E OPEN/CLOSE · A ADD STEP · O ADD OP · D DUPLICATE · X
							DELETE · ALT+UP/DOWN MOVE · P PREVIEW
						</p>
					{/if}
				{/if}
			{/if}
		</div>
	</div>
	<aside
		class="min-w-0 overflow-x-hidden lg:h-full lg:min-h-0 lg:overflow-y-hidden lg:pb-4"
		aria-label="Executions, issues and reference documents"
	>
		<TemplateSide {data} {startable} onchange={onreload} />
	</aside>
</div>
