<script lang="ts">
	// The execution document page: header and blocking state over the live
	// document, the OP index and roster in a left sidebar, the surrounding
	// record (issues, evidence, facts) in the DETAILS tab.
	import { onMount, tick } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { confirm, PageHeader, State, TabStrip, toastError } from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { cn } from '#lib/utils.js';
	import { ProcedureDocument } from '#lib/components/procedure-doc/index.js';
	import { session } from '#lib/session.svelte.js';
	import { ExecutionStore } from '#lib/execution/store.svelte.js';
	import DataPanel from './DataPanel.svelte';
	import ExecutionDialogs from './ExecutionDialogs.svelte';
	import ExecutionNav from './ExecutionNav.svelte';
	import ExecutionSide from './ExecutionSide.svelte';
	import ExecutionRecord from './ExecutionRecord.svelte';
	import MaterialPanel from './MaterialPanel.svelte';

	let { id }: { id: number } = $props();

	// svelte-ignore state_referenced_locally
	const store = new ExecutionStore(id, session.user?.id ?? null);
	let editing = $state(false);

	onMount(() => {
		store.start().then(() => {
			// Deep links: ?step=N (snapshot order) or ?op=N jump and expand; with
			// ?redline_issue=ID the redline dialog opens on that OP, linked to the NC.
			const q = page.url.searchParams;
			const target = Number(q.get('step')) || Number(q.get('op'));
			if (target) store.jumpTo(target);
			const issueId = Number(q.get('redline_issue'));
			const opOrder = Number(q.get('op'));
			if (issueId && opOrder && store.active) {
				const hit = store.allOps.find((o) => o.order === opOrder);
				if (hit?.open_ncs.some((n) => n.id === issueId)) {
					store.dialog = { kind: 'redline', op: hit, issueId };
				} else if (hit) {
					toastError(new Error('That issue is not an open NC on this OP'));
				}
			}
		});
		return () => store.stop();
	});

	const doc = $derived(store.doc);
	const inst = $derived(doc?.instance);
	const hasData = $derived(
		!!doc &&
			(doc.data_rows.length > 0 ||
				[...doc.ops, ...doc.contingency_ops].some((o) =>
					[o.step, ...o.steps].some((s) => (s.data_schema?.fields?.length ?? 0) > 0)
				))
	);
	const tabs = $derived([
		{ id: 'document', label: 'Document' },
		...(hasData ? [{ id: 'data', label: 'Data' }] : []),
		...(doc?.material_relevant ? [{ id: 'material', label: 'Material' }] : []),
		{ id: 'details', label: 'Details' }
	]);
	const tab = $derived(
		tabs.find((t) => t.id === page.url.searchParams.get('tab'))?.id ?? 'document'
	);
	const pct = $derived(doc?.progress.total ? (doc.progress.done / doc.progress.total) * 100 : 0);
	const holds = $derived(
		(doc?.holds ?? []).filter((h) => h.disposition_state === 'undispositioned')
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

	async function abort() {
		if (!inst) return;
		const ok = await confirm({
			title: `Abort ${inst.work_order ?? 'work order'}?`,
			body: 'In-progress work stops, the work order closes as ABORTED, and it cannot be resumed.',
			action: 'ABORT',
			destructive: true
		});
		if (!ok) return;
		try {
			await store.abort();
		} catch (e) {
			toastError(e, 'Failed to abort');
		}
	}
</script>

<svelte:window onkeydown={(e) => store.handleKey(e)} />

{#if store.loading}
	<div class="p-4"><div class="h-24 animate-pulse bg-muted"></div></div>
{:else if store.error || !doc || !inst}
	<div class="p-4">
		<p
			role="alert"
			class="rounded-md border border-error/40 bg-error-muted px-3 py-2 text-xs text-error"
		>
			{store.error ?? 'Execution not found'}
		</p>
		<p class="mt-2 text-xs">
			<a class="text-info hover:underline" href="/executions">Back to executions</a>
		</p>
	</div>
{:else}
	<!-- On wide screens the page is locked to the viewport: header, progress strip and
	     tabs stay put; only the tab content scrolls, beside the fixed-height sidebar. -->
	<div class="flex min-w-0 flex-col lg:h-[calc(100svh-var(--shell-h))]">
		<div class="shrink-0">
			<PageHeader
				identifier={inst.work_order ?? 'EXECUTION'}
				title={inst.procedure.name}
				crumbs={[
					{ label: 'Executions', href: '/executions' },
					{ label: inst.work_order ?? 'Execution' }
				]}
			>
				{#snippet state()}
					<span class="font-mono text-xs text-muted-foreground">v{inst.version.number}</span>
					<State value={inst.status} badge={inst.status === 'aborted'} />
					{#if inst.priority > 0}
						<State
							value="priority"
							tone={inst.priority > 1 ? 'error' : 'warn'}
							label={inst.priority > 1 ? 'URGENT' : 'HIGH'}
							badge
						/>
					{/if}
				{/snippet}
				{#snippet actions()}
					{#if inst.status === 'completed'}
						<Button
							size="sm"
							variant="outline"
							href={`/executions/${inst.id}/report`}
							target="_blank"
							rel="noopener">REPORT</Button
						>
					{/if}
					{#if inst.active}
						<Button size="sm" variant="destructive" onclick={abort}>ABORT</Button>
					{/if}
				{/snippet}
			</PageHeader>

			<div class="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border px-4 py-2">
				<div class="flex items-center gap-2" title="Steps complete">
					<div
						class="h-1.5 w-40 bg-border"
						role="progressbar"
						aria-label="Steps complete"
						aria-valuenow={Math.round(pct)}
						aria-valuemin={0}
						aria-valuemax={100}
					>
						<div class="h-full bg-ok" style:width={`${pct}%`}></div>
					</div>
					<span class="font-mono text-xs tabular-nums"
						>{doc.progress.done}/{doc.progress.total}</span
					>
				</div>
				{#each holds as h (h.issue_id)}
					<span class="font-mono text-xs text-warn">
						HELD BY <a class="underline" href={`/issues/${h.issue_id}`}>{h.issue_number}</a>
						{#if h.blocks.length}<span class="text-muted-foreground">({h.blocks.join(', ')})</span
							>{/if}
					</span>
				{/each}
			</div>
		</div>
		<div
			class="grid min-h-0 flex-1 grid-cols-1 items-start gap-4 p-4 lg:grid-cols-[fit-content(20%)_minmax(0,1fr)_fit-content(20%)] lg:grid-rows-[minmax(0,1fr)] lg:items-stretch lg:pb-0"
		>
			<aside
				class="min-w-0 overflow-x-hidden lg:h-full lg:min-h-0 lg:overflow-y-hidden lg:pb-4"
				aria-label="Operations"
			>
				<ExecutionNav {store} onjump={jump} />
			</aside>
			<div class="flex min-h-0 min-w-0 flex-col gap-3">
				<TabStrip {tabs} value={tab} onchange={setTab} class="shrink-0">
					{#snippet end()}
						{#if tab === 'document'}
							<button
								type="button"
								class={cn(
									'px-3 font-mono text-xs font-medium tracking-wider uppercase outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset',
									store.focusMode
										? 'bg-card text-info'
										: 'text-muted-foreground hover:text-foreground'
								)}
								aria-pressed={store.focusMode}
								title="Show only the operation selected in the sidebar"
								onclick={() => store.setFocusMode(!store.focusMode)}>Focus</button
							>
						{/if}
					{/snippet}
				</TabStrip>
				<div id="exec-scroll" class="min-h-0 min-w-0 flex-1 lg:overflow-y-auto lg:pb-4">
					{#if tab === 'document'}
						<ProcedureDocument
							controller={store}
							ops={doc.ops.filter((o) => store.shownOps.includes(o))}
							contingency={doc.contingency_ops.filter((o) => store.shownOps.includes(o))}
						/>
					{:else if tab === 'data'}
						<DataPanel {store} />
					{:else if tab === 'material'}
						<MaterialPanel {store} />
					{:else if tab === 'details'}
						<ExecutionRecord {store} onedit={() => (editing = true)} onjump={jump} />
					{/if}
				</div>
			</div>
			<aside
				class="min-w-0 overflow-x-hidden lg:h-full lg:min-h-0 lg:overflow-y-hidden lg:pb-4"
				aria-label="Online, issues and reference documents"
			>
				<ExecutionSide {store} onjump={jump} />
			</aside>
		</div>
	</div>
	<ExecutionDialogs {store} bind:editing />
{/if}
