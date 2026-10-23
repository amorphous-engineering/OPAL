<script lang="ts">
	// Baseline review: one ready requirement at a time, approve or skip, then
	// commit the approved set as one signed event. Nothing is written until
	// COMMIT; leaving the page abandons the session.
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import {
		DataTable,
		DetailRow,
		DetailTable,
		EmptyLine,
		PageHeader,
		Section,
		State,
		toast,
		confirm,
		type Column
	} from '#lib/components/opal/index.js';
	import { api, ApiError, formatDetail } from '#lib/api.js';
	import { iso } from '#lib/format.js';
	import { session } from '#lib/session.svelte.js';
	import Redline from '#lib/components/requirements/Redline.svelte';
	import type { QueueItem } from '#lib/components/requirements/types.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const items = $derived(data.items);

	const STORE = 'opal_req_queue';
	let staged = $state<number[]>([]);
	let skipped = $state<number[]>([]);
	let cursor = $state(0);
	let label = $state('');
	let note = $state('');
	let busy = $state(false);
	let error = $state<string | null>(null);

	onMount(() => {
		// Restore an unfinished session (ids that are no longer ready drop out below).
		try {
			const saved = JSON.parse(sessionStorage.getItem(STORE) ?? 'null');
			if (saved) {
				staged = saved.staged ?? [];
				skipped = saved.skipped ?? [];
			}
		} catch {
			/* storage unavailable: start fresh */
		}
	});

	$effect(() => {
		const ready = new Set(items.map((i) => i.id));
		const keep = (list: number[]) => list.filter((id) => ready.has(id));
		if (keep(staged).length !== staged.length) staged = keep(staged);
		if (keep(skipped).length !== skipped.length) skipped = keep(skipped);
	});

	$effect(() => {
		try {
			sessionStorage.setItem(STORE, JSON.stringify({ staged, skipped }));
		} catch {
			/* convenience only */
		}
	});

	const current = $derived<QueueItem | undefined>(items[Math.min(cursor, items.length - 1)]);
	const stagedItems = $derived(items.filter((i) => staged.includes(i.id)));

	function status(i: QueueItem): 'staged' | 'skipped' | 'pending' {
		return staged.includes(i.id) ? 'staged' : skipped.includes(i.id) ? 'skipped' : 'pending';
	}

	function advance() {
		const next = items.findIndex((it, i) => i > cursor && status(it) === 'pending');
		if (next !== -1) return (cursor = next);
		const any = items.findIndex((it) => status(it) === 'pending');
		if (any !== -1) cursor = any;
	}

	function disposition(kind: 'approve' | 'skip') {
		if (!current) return;
		const id = current.id;
		if (kind === 'approve') {
			staged = [...staged.filter((x) => x !== id), id];
			skipped = skipped.filter((x) => x !== id);
		} else {
			skipped = [...skipped.filter((x) => x !== id), id];
			staged = staged.filter((x) => x !== id);
		}
		advance();
	}

	function edit() {
		if (!current) return;
		// Edited text must be read fresh next time, never approved hot.
		staged = staged.filter((x) => x !== current!.id);
		goto(`/requirements/${current.id}`);
	}

	async function abandon() {
		if (staged.length) {
			const ok = await confirm({
				title: 'Abandon review?',
				body: `${staged.length} approved ${staged.length === 1 ? 'requirement is' : 'requirements are'} not baselined until committed.`,
				action: 'ABANDON',
				destructive: true
			});
			if (!ok) return;
		}
		try {
			sessionStorage.removeItem(STORE);
		} catch {
			/* nothing stored */
		}
		goto('/requirements');
	}

	async function commit() {
		busy = true;
		error = null;
		try {
			const r = await api.post<{ event_id: number }>('/requirements/baseline-batch', {
				ids: stagedItems.map((i) => i.id),
				label: label.trim() || null,
				note: note.trim() || null
			});
			try {
				sessionStorage.removeItem(STORE);
			} catch {
				/* nothing stored */
			}
			toast.success(`${stagedItems.length} baselined`);
			await goto(`/requirements/baselines/${r.event_id}`);
		} catch (e) {
			if (e instanceof ApiError && typeof e.detail === 'object' && e.detail) {
				const d = e.detail as { offenders?: { req_number: string }[] };
				error = d.offenders
					? `Batch aborted, no longer ready: ${d.offenders.map((o) => o.req_number).join(', ')}`
					: formatDetail(e.detail);
			} else error = e instanceof Error ? e.message : 'Batch failed';
		} finally {
			busy = false;
		}
	}

	function onkeydown(e: KeyboardEvent) {
		if ((e.target as HTMLElement).closest('input, textarea, select, [role="dialog"]')) return;
		if (e.ctrlKey || e.metaKey || e.altKey || !items.length) return;
		switch (e.key) {
			case 'a':
				e.preventDefault();
				disposition('approve');
				break;
			case 's':
				e.preventDefault();
				disposition('skip');
				break;
			case 'e':
				e.preventDefault();
				edit();
				break;
			case 'j':
				e.preventDefault();
				cursor = Math.min(items.length - 1, cursor + 1);
				break;
			case 'k':
				e.preventDefault();
				cursor = Math.max(0, cursor - 1);
				break;
			case 'Escape':
				abandon();
				break;
		}
	}

	const columns: Column<QueueItem>[] = [
		{ key: 'req_number', label: 'Number', mono: true, width: '7rem' },
		{ key: 'title', label: 'Title' },
		{ key: 'level', label: 'L', mono: true, width: '3rem', align: 'right' },
		{ key: 'disposition', label: 'Review', width: '6rem' }
	];
</script>

<svelte:window {onkeydown} />

<PageHeader
	title="Baseline queue"
	crumbs={[{ label: 'Requirements', href: '/requirements' }, { label: 'Queue' }]}
>
	{#snippet actions()}
		<Button size="sm" variant="outline" onclick={abandon}>ABANDON</Button>
	{/snippet}
</PageHeader>

<div class="grid grid-cols-1 gap-4 p-4">
	{#if !items.length}
		<EmptyLine label="Ready to baseline" empty="Nothing ready to baseline." />
	{:else}
		<div class="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_28rem]">
			{#if current}
				<Section
					title={`${current.req_number} REV ${current.revision}`}
					count={`${cursor + 1} of ${items.length}`}
				>
					{#snippet actions()}
						<span class="mr-2 hidden font-mono text-xs text-muted-foreground md:inline"
							>a approve · s skip · e edit · j/k move · esc abandon</span
						>
						<Button size="xs" onclick={() => disposition('approve')}>APPROVE</Button>
						<Button size="xs" variant="outline" onclick={() => disposition('skip')}>SKIP</Button>
						<Button size="xs" variant="outline" onclick={edit}>EDIT</Button>
					{/snippet}
					<DetailTable>
						<DetailRow label="Title">{current.title}</DetailRow>
						<DetailRow label="Parent chain">
							{#if current.chain.length}
								<span class="flex flex-wrap items-center gap-x-1 font-mono text-xs">
									{#each current.chain as p, i (p.id)}
										{#if i > 0}<span class="text-muted-foreground">▸</span>{/if}
										<a
											href={`/requirements/${p.id}`}
											class="text-info hover:underline"
											title={p.title}>{p.req_number}</a
										>
										{#if p.lifecycle_state !== 'baselined'}<span class="text-warn"
												>{p.lifecycle_state}</span
											>{/if}
									{/each}
									<span class="text-muted-foreground">▸</span><span>{current.req_number}</span>
								</span>
							{:else}<span class="text-muted-foreground">Level-0 root</span>{/if}
						</DetailRow>
						<DetailRow label="Statement"
							><span class="font-mono text-sm">{current.statement}</span></DetailRow
						>
						<DetailRow label="Rationale" value={current.rationale} />
						<DetailRow
							label="Verification"
							value={current.verification_method?.toUpperCase()}
							mono
						/>
						<DetailRow label="Children" value={current.children_count} mono />
						<DetailRow label="Parts" value={current.parts.join(', ')} />
						{#if current.warnings.length}
							<DetailRow label="Warnings">
								<span class="text-warn">{current.warnings.join('; ')}</span>
							</DetailRow>
						{/if}
						{#if current.change}
							<DetailRow label={`Change since rev ${current.change.rev_a}`}>
								<div class="grid grid-cols-1 gap-1">
									<Redline segments={current.change.statement} />
									<Redline segments={current.change.rationale} />
								</div>
							</DetailRow>
						{/if}
					</DetailTable>
				</Section>
			{/if}

			<div class="grid grid-cols-1 gap-4">
				<Section title="QUEUE" count={`${staged.length} approved · ${skipped.length} skipped`}>
					<DataTable
						rows={items}
						{columns}
						onrowclick={(r) => (cursor = items.findIndex((x) => x.id === r.id))}
						rowClass={(r) => (r.id === current?.id ? 'bg-accent' : undefined)}
						key={(r) => r.id}
						emptyLabel="Queue"
						dense
					>
						{#snippet cell(r, col)}
							{#if col.key === 'req_number'}<span class="text-info">{r.req_number}</span>
							{:else if col.key === 'disposition'}
								{@const s = status(r)}
								{#if s === 'staged'}<State value="staged" tone="ok" label="APPROVED" />
								{:else if s === 'skipped'}<State value="skipped" tone="muted" label="SKIPPED" />
								{:else}<span class="text-muted-foreground">—</span>{/if}
							{:else if col.key === 'level'}{r.level}
							{:else}{r.title}{/if}
						{/snippet}
					</DataTable>
				</Section>

				<Section title="COMMIT" count={stagedItems.length}>
					<form
						class="grid grid-cols-1 gap-3 p-3"
						onsubmit={(e) => {
							e.preventDefault();
							commit();
						}}
					>
						{#if error}
							<p
								role="alert"
								class="rounded-md border border-error/40 bg-error-muted px-2 py-1.5 text-xs text-error"
							>
								{error}
							</p>
						{/if}
						<div class="grid grid-cols-1 gap-1.5">
							<Label for="q-label">Label</Label>
							<Input
								id="q-label"
								bind:value={label}
								maxlength={100}
								placeholder="l0-freeze"
								class="font-mono"
							/>
						</div>
						<div class="grid grid-cols-1 gap-1.5">
							<Label for="q-note">Note</Label>
							<Textarea id="q-note" bind:value={note} rows={2} />
						</div>
						<p class="font-mono text-xs text-muted-foreground">
							signed {session.user?.name ?? '—'} · {iso(new Date()).slice(0, 19)}Z
						</p>
						<Button type="submit" disabled={busy || !stagedItems.length}
							>COMMIT BASELINE · {stagedItems.length}</Button
						>
					</form>
				</Section>
			</div>
		</div>
	{/if}
</div>
