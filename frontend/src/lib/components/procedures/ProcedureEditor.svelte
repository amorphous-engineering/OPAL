<script lang="ts">
	// The template as the document the operator will execute, editable in place.
	// An outline rail beside it; EDIT / PREVIEW switches between the author's
	// view and the operator's without leaving the page.
	import { onMount, untrack } from 'svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import { cn } from '#lib/utils.js';
	import { ProcedureDocument } from '#lib/components/procedure-doc/index.js';
	import { AuthorStore } from '#lib/authoring/store.svelte.js';
	import { PreviewController } from '#lib/authoring/preview.svelte.js';
	import { Timestamp } from '#lib/components/opal/index.js';

	let {
		procedureId,
		onchange
	}: { procedureId: number; onchange?: (counts: { ops: number; steps: number }) => void } =
		$props();

	// svelte-ignore state_referenced_locally
	const store = new AuthorStore(procedureId, () => onchange?.(store.counts));
	const preview = new PreviewController();
	let previewing = $state(false);

	onMount(() => {
		store.start();
		return () => store.stop();
	});

	const doc = $derived(store.doc);
	const total = $derived(store.counts.ops + store.counts.steps);
	const status = $derived(store.status);

	// Report the size of the template to the page once it is known and when it changes.
	$effect(() => {
		const c = store.counts;
		untrack(() => onchange?.(c));
	});

	function onKey(e: KeyboardEvent) {
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
</script>

<svelte:window onkeydown={onKey} />

<section aria-label="Operations" data-editor>
	<header
		class="sticky top-12 z-10 flex min-h-8 flex-wrap items-center gap-x-3 gap-y-1 border border-border bg-muted px-3 py-1"
	>
		<h2 class="label text-foreground">Operations</h2>
		<span class="font-mono text-xs text-muted-foreground"
			>{total} STEPS ({store.counts.ops} OP{store.counts.ops === 1 ? '' : 'S'})</span
		>
		<span
			class={cn(
				'font-mono text-xs',
				status === 'error' && 'text-error',
				(status === 'saving' || status === 'dirty') && 'text-warn',
				(status === 'saved' || status === 'idle') && 'text-muted-foreground'
			)}
			role="status"
			aria-live="polite"
			data-save-status={status}
		>
			{#if status === 'error'}
				NOT SAVED · <button type="button" class="underline" onclick={() => store.retry()}
					>RETRY</button
				>
			{:else if status === 'saving' || status === 'dirty'}
				SAVING
			{:else if store.savedAt}
				SAVED <Timestamp value={new Date(store.savedAt).toISOString()} />
			{/if}
		</span>
		<span class="ml-auto flex items-center gap-1">
			{#if !previewing}
				<Button size="xs" variant="ghost" onclick={() => store.setAllOpen(true)}>EXPAND ALL</Button>
				<Button size="xs" variant="ghost" onclick={() => store.setAllOpen(false)}
					>COLLAPSE ALL</Button
				>
			{/if}
			<span class="flex" role="group" aria-label="View">
				<Button
					size="xs"
					variant={previewing ? 'outline' : 'default'}
					aria-pressed={!previewing}
					onclick={() => (previewing = false)}>EDIT</Button
				>
				<Button
					size="xs"
					variant={previewing ? 'default' : 'outline'}
					aria-pressed={previewing}
					title="The document as an operator sees it (p)"
					onclick={() => (previewing = true)}>PREVIEW</Button
				>
			</span>
		</span>
	</header>

	{#if store.stale}
		<div
			class="flex items-center gap-3 border border-t-0 border-warn/50 bg-warn-muted px-3 py-1.5 text-xs"
			role="status"
		>
			<span class="font-mono text-warn">CHANGED ELSEWHERE</span>
			<Button size="xs" variant="outline" onclick={() => store.refreshFromServer()}>REFRESH</Button>
		</div>
	{/if}

	{#if store.loading}
		<div class="mt-3 h-24 animate-pulse bg-muted"></div>
	{:else if store.error}
		<p role="alert" class="mt-3 border border-error/40 bg-error-muted px-3 py-2 text-xs text-error">
			{store.error}
		</p>
	{:else}
		<div class="mt-3 grid grid-cols-1 items-start gap-4 lg:grid-cols-[13rem_minmax(0,1fr)]">
			<nav
				class="hidden max-h-[calc(100svh-7rem)] overflow-y-auto border border-border bg-card lg:sticky lg:top-24 lg:block"
				aria-label="Outline"
			>
				<ol class="m-0 list-none p-0">
					{#each [...doc.ops, ...doc.contingency] as op (op.order)}
						<li class="border-b border-border last:border-b-0">
							<button
								type="button"
								class={cn(
									'flex w-full items-baseline gap-2 px-2 py-1 text-left text-xs hover:bg-accent/60',
									store.focusedOrder === op.order && 'bg-accent/40'
								)}
								onclick={() => store.jumpTo(op.order)}
							>
								<span class="w-7 shrink-0 font-mono text-muted-foreground">{op.number}</span>
								<span class="min-w-0 flex-1 truncate">{op.title || '—'}</span>
								<span class="shrink-0 font-mono text-xs text-muted-foreground"
									>{op.steps.length || ''}</span
								>
							</button>
						</li>
					{/each}
				</ol>
			</nav>
			<div class="min-w-0">
				{#if previewing}
					<ProcedureDocument controller={preview} ops={doc.ops} contingency={doc.contingency} />
				{:else}
					<ProcedureDocument controller={store} ops={doc.ops} contingency={doc.contingency} />
					{#if total > 0}
						<p class="mt-2 font-mono text-xs text-muted-foreground">
							J/K MOVE · ENTER EDIT TITLE · E OPEN/CLOSE · A ADD STEP · O ADD OP · D DUPLICATE · X
							DELETE · ALT+UP/DOWN MOVE · P PREVIEW
						</p>
					{/if}
				{/if}
			</div>
		</div>
	{/if}
</section>
