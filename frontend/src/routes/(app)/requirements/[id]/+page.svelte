<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
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
		toastError,
		type Column
	} from '#lib/components/opal/index.js';
	import { api } from '#lib/api.js';
	import { iso } from '#lib/format.js';
	import { session } from '#lib/session.svelte.js';
	import LintEditor from '#lib/components/requirements/LintEditor.svelte';
	import PartPicker from '#lib/components/requirements/PartPicker.svelte';
	import QuickCreate from '#lib/components/requirements/QuickCreate.svelte';
	import Redline from '#lib/components/requirements/Redline.svelte';
	import {
		LEVELS,
		VERIFICATION_METHODS,
		lifecycleTone,
		verificationLabel,
		verificationTone
	} from '#lib/components/requirements/lifecycle.js';
	import type { Allocation, Dossier, RedlineData } from '#lib/components/requirements/types.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const req = $derived(data.req);
	const mutable = $derived(
		req.lifecycle_state === 'draft' || req.lifecycle_state === 'preliminary'
	);
	const terminal = $derived(
		req.lifecycle_state === 'superseded' || req.lifecycle_state === 'cancelled'
	);

	// Local copies of the text fields; reset whenever the server row changes.
	let statement = $state('');
	let rationale = $state('');
	let title = $state('');
	let category = $state('');
	$effect(() => {
		statement = req.statement;
		rationale = req.rationale ?? '';
		title = req.title;
		category = req.category ?? '';
	});

	async function save(patch: Record<string, unknown>) {
		try {
			await api.patch(`/requirements/${req.id}`, patch);
			await invalidateAll();
		} catch (e) {
			toastError(e);
			await invalidateAll();
		}
	}

	function saveText(field: 'title' | 'category' | 'statement' | 'rationale', value: string) {
		const current = (req[field] ?? '') as string;
		if (value === current) return;
		if ((field === 'title' || field === 'statement') && !value.trim()) {
			toastError(new Error(`${field} cannot be empty`));
			invalidateAll();
			return;
		}
		save({ [field]: value.trim() === '' ? null : value });
	}

	const nowIso = () => iso(new Date()).slice(0, 19) + 'Z';
	const who = () => session.user?.name ?? 'unknown user';

	// ---- lifecycle actions ----
	async function baselineIt() {
		const ok = await confirm({
			title: `Baseline ${req.req_number} rev ${req.revision}`,
			body: `This locks the revision; later changes need a new revision. Signed ${who()} · ${nowIso()}.`,
			action: 'BASELINE'
		});
		if (!ok) return;
		try {
			await api.post(`/requirements/${req.id}/baseline`);
			toast.success(`${req.req_number} baselined`);
			await invalidateAll();
		} catch (e) {
			toastError(e);
			await invalidateAll();
		}
	}

	async function revise() {
		try {
			const next = await api.post<{ id: number }>(`/requirements/${req.id}/revise`);
			await goto(`/requirements/${next.id}`);
		} catch (e) {
			toastError(e);
		}
	}

	async function cancelIt() {
		const ok = await confirm({
			title: `Cancel ${req.req_number}?`,
			body: 'Cancelled is terminal. The requirement stays in the record and cannot be revised or baselined again.',
			action: 'CANCEL REQUIREMENT',
			destructive: true
		});
		if (!ok) return;
		try {
			await api.post(`/requirements/${req.id}/cancel`);
			await invalidateAll();
		} catch (e) {
			toastError(e);
		}
	}

	async function deleteIt() {
		const ok = await confirm({
			title: `Delete ${req.req_number}?`,
			body: 'The draft is removed. Its number is not reused.',
			action: 'DELETE',
			destructive: true
		});
		if (!ok) return;
		try {
			await api.del(`/requirements/${req.id}`);
			await goto('/requirements');
		} catch (e) {
			toastError(e);
		}
	}

	async function reaffirm() {
		const ok = await confirm({
			title: `Re-affirm ${req.req_number}`,
			body: `The parent's change does not invalidate this requirement. Signed ${who()} · ${nowIso()}.`,
			action: 'RE-AFFIRM'
		});
		if (!ok) return;
		try {
			await api.post(`/requirements/${req.id}/reaffirm`);
			await invalidateAll();
		} catch (e) {
			toastError(e);
		}
	}

	// ---- parts (allocations) ----
	async function assign(part: { id: number; name: string }) {
		try {
			await api.post(`/requirements/parts/${part.id}`, { requirement_id: req.req_number });
			toast.success(`${part.name} assigned`);
			await invalidateAll();
		} catch (e) {
			toastError(e);
		}
	}

	async function setStatus(a: Allocation, status: string) {
		try {
			if (status === 'verified') await api.post(`/requirements/allocations/${a.id}/verify`, {});
			else await api.patch(`/requirements/allocations/${a.id}`, { status });
		} catch (e) {
			toastError(e);
		}
		await invalidateAll();
	}

	async function setNotes(a: Allocation, notes: string) {
		if (notes === (a.notes ?? '')) return;
		try {
			await api.patch(`/requirements/allocations/${a.id}`, { notes });
			await invalidateAll();
		} catch (e) {
			toastError(e);
		}
	}

	async function unassign(a: Allocation) {
		const ok = await confirm({
			title: `Unassign ${a.part_name} from ${req.req_number}?`,
			body: 'The part stops carrying this requirement and its verification record is removed.',
			action: 'UNASSIGN',
			destructive: true
		});
		if (!ok) return;
		try {
			await api.del(`/requirements/allocations/${a.id}`);
			await invalidateAll();
		} catch (e) {
			toastError(e);
		}
	}

	const allocColumns: Column<Allocation>[] = [
		{ key: 'part_name', label: 'Part' },
		{ key: 'internal_pn', label: 'Part number', mono: true, width: '9rem' },
		{ key: 'status', label: 'Verification', width: '10rem' },
		{ key: 'verified', label: 'Verified', width: '13rem' },
		{ key: 'against_revision', label: 'Rev', mono: true, width: '4rem', align: 'right' },
		{ key: 'notes', label: 'Notes', width: '18rem' },
		{ key: 'actions', label: '', width: '6rem', align: 'right' }
	];

	// ---- flow-down ----
	let qcOpen = $state(false);
	const childColumns: Column<Dossier['children'][number]>[] = [
		{ key: 'req_number', label: 'Number', mono: true, width: '7rem' },
		{ key: 'title', label: 'Title' },
		{ key: 'lifecycle_state', label: 'State', width: '8rem' },
		{ key: 'level', label: 'L', mono: true, width: '3rem', align: 'right' },
		{ key: 'stale', label: 'Flags', width: '6rem' }
	];

	// ---- revisions and redline ----
	const revColumns: Column<Dossier['revisions'][number]>[] = [
		{ key: 'revision', label: 'Rev', mono: true, width: '4rem' },
		{ key: 'lifecycle_state', label: 'State', width: '8rem' },
		{ key: 'statement', label: 'Statement' },
		{ key: 'baselined_at', label: 'Baselined', width: '10rem' }
	];
	let revA = $state(0);
	let revB = $state(0);
	let redline = $state<RedlineData | null>(null);
	$effect(() => {
		revA = req.predecessor_revision ?? req.revision;
		revB = req.revision;
	});
	$effect(() => {
		const [a, b, id] = [revA, revB, req.id];
		if (req.revisions.length < 2 || a === b || !a || !b) {
			redline = null;
			return;
		}
		api
			.get<RedlineData>(`/requirements/${id}/redline`, { rev_a: a, rev_b: b })
			.then((r) => (redline = r))
			.catch(() => (redline = null));
	});

	const eventColumns: Column<Dossier['baseline_events'][number]>[] = [
		{ key: 'created_at', label: 'When', width: '10rem' },
		{ key: 'revision', label: 'Rev', mono: true, width: '4rem' },
		{ key: 'label', label: 'Label' }
	];

	const failingHard = $derived(
		req.readiness?.checks.filter((c) => c.severity === 'hard' && !c.passed).length ?? 0
	);
</script>

<PageHeader
	title={req.title}
	identifier={req.req_number}
	crumbs={[
		{ label: 'Requirements', href: '/requirements' },
		...req.parent_chain.map((p) => ({ label: p.req_number, href: `/requirements/${p.id}` })),
		{ label: req.req_number }
	]}
>
	{#snippet state()}
		<State value={req.lifecycle_state} tone={lifecycleTone(req.lifecycle_state)} badge />
		<span class="mono text-xs text-muted-foreground">REV {req.revision}</span>
		{#if req.stale}
			<span
				class="font-mono text-xs font-medium text-warn"
				title="Parent was revised after this row last got a fresh look">STALE</span
			>
		{/if}
	{/snippet}
	{#snippet actions()}
		{#if req.stale}<Button size="sm" variant="outline" onclick={reaffirm}>RE-AFFIRM</Button>{/if}
		{#if req.lifecycle_state === 'baselined'}
			<Button size="sm" onclick={revise}>REVISE</Button>
		{/if}
		{#if req.can_delete}
			<Button size="sm" variant="outline" class="text-error" onclick={deleteIt}>DELETE</Button>
		{/if}
		{#if !terminal}
			<Button size="sm" variant="outline" class="text-error" onclick={cancelIt}>CANCEL</Button>
		{/if}
	{/snippet}
</PageHeader>

<div class="grid gap-4 p-4">
	<Section title="REQUIREMENT">
		<DetailTable>
			<DetailRow label="Statement">
				{#if mutable}
					<LintEditor
						bind:value={statement}
						findings={req.lint}
						onsave={(t) => saveText('statement', t)}
					/>
				{:else}
					<span class="font-mono text-xs">{req.statement}</span>
				{/if}
			</DetailRow>
			<DetailRow label="Rationale">
				{#if mutable}
					<Textarea
						bind:value={rationale}
						rows={2}
						placeholder="Where the number came from and what it protects"
						onblur={() => saveText('rationale', rationale)}
					/>
				{:else if req.rationale}
					{req.rationale}
				{:else}
					<span class="text-muted-foreground">—</span>
				{/if}
			</DetailRow>
		</DetailTable>
		<div class="grid border-t border-border md:grid-cols-2 md:divide-x md:divide-border">
			<DetailTable>
				<DetailRow label="Title">
					{#if mutable}
						<Input
							class="h-7"
							bind:value={title}
							maxlength={255}
							onblur={() => saveText('title', title)}
						/>
					{:else}{req.title}{/if}
				</DetailRow>
				<DetailRow label="Category">
					{#if mutable}
						<Input
							class="h-7"
							bind:value={category}
							maxlength={50}
							placeholder="functional, performance, interface"
							onblur={() => saveText('category', category)}
						/>
					{:else}{req.category ?? '—'}{/if}
				</DetailRow>
				<DetailRow label="Parent">
					{#if mutable}
						<NativeSelect
							size="sm"
							class="w-full"
							value={String(req.parent_id ?? '')}
							onchange={(e) =>
								save({ parent_id: e.currentTarget.value ? Number(e.currentTarget.value) : null })}
							aria-label="Parent"
						>
							<NativeSelectOption value="">None (root)</NativeSelectOption>
							{#each data.parents as p (p.id)}
								<NativeSelectOption value={String(p.id)}
									>{p.req_number} {p.title}</NativeSelectOption
								>
							{/each}
						</NativeSelect>
					{:else if req.parent_chain.length}
						{@const p = req.parent_chain[req.parent_chain.length - 1]}
						<a href={`/requirements/${p.id}`} class="hover:underline"
							><span class="mono text-info">{p.req_number}</span> {p.title}</a
						>
					{:else}<span class="text-muted-foreground">—</span>{/if}
				</DetailRow>
				<DetailRow label="Level">
					{#if mutable}
						<NativeSelect
							size="sm"
							value={String(req.level)}
							onchange={(e) => save({ level: Number(e.currentTarget.value) })}
							aria-label="Level"
						>
							{#each LEVELS as l (l.value)}
								<NativeSelectOption value={String(l.value)}>{l.label}</NativeSelectOption>
							{/each}
							{#if !LEVELS.some((l) => l.value === req.level)}
								<NativeSelectOption value={String(req.level)}>L{req.level}</NativeSelectOption>
							{/if}
						</NativeSelect>
					{:else}<span class="mono">L{req.level}</span>{/if}
				</DetailRow>
				<DetailRow label="Verification method">
					{#if mutable}
						<NativeSelect
							size="sm"
							value={req.verification_method ?? ''}
							onchange={(e) => save({ verification_method: e.currentTarget.value || null })}
							aria-label="Verification method"
						>
							<NativeSelectOption value="">Not set</NativeSelectOption>
							{#each VERIFICATION_METHODS as m (m)}
								<NativeSelectOption value={m}>{m.toUpperCase()}</NativeSelectOption>
							{/each}
						</NativeSelect>
					{:else}<span class="mono">{req.verification_method?.toUpperCase() ?? '—'}</span>{/if}
				</DetailRow>
				<DetailRow label="Verification">
					<State
						value={req.verification}
						label={verificationLabel[req.verification]}
						tone={verificationTone(req.verification)}
					/>
				</DetailRow>
			</DetailTable>
			<DetailTable>
				<DetailRow label="TBD">
					{#if mutable}
						<Checkbox
							checked={req.tbd}
							onCheckedChange={(v) => save({ tbd: !!v })}
							aria-label="TBD"
						/>
					{:else if req.tbd}<State value="tbd" tone="error" label="TBD" />{:else}<span
							class="text-muted-foreground">—</span
						>{/if}
				</DetailRow>
				<DetailRow label="TBR">
					{#if mutable}
						<Checkbox
							checked={req.tbr}
							onCheckedChange={(v) => save({ tbr: !!v })}
							aria-label="TBR"
						/>
					{:else if req.tbr}<State value="tbr" tone="warn" label="TBR" />{:else}<span
							class="text-muted-foreground">—</span
						>{/if}
				</DetailRow>
				<DetailRow label="TBR owner">
					{#if mutable}
						<NativeSelect
							size="sm"
							value={String(req.tbr_owner_id ?? '')}
							onchange={(e) =>
								save({
									tbr_owner_id: e.currentTarget.value ? Number(e.currentTarget.value) : null
								})}
							aria-label="TBR owner"
						>
							<NativeSelectOption value="">Not set</NativeSelectOption>
							{#each data.assignees as u (u.id)}
								<NativeSelectOption value={String(u.id)}>{u.name}</NativeSelectOption>
							{/each}
						</NativeSelect>
					{:else}{req.tbr_owner ?? '—'}{/if}
				</DetailRow>
				<DetailRow label="TBR due">
					{#if mutable}
						<Input
							type="date"
							class="h-7 w-40 font-mono"
							value={req.tbr_due?.slice(0, 10) ?? ''}
							onchange={(e) =>
								save({
									tbr_due: e.currentTarget.value ? `${e.currentTarget.value}T00:00:00Z` : null
								})}
							aria-label="TBR due"
						/>
					{:else}<Timestamp value={req.tbr_due} dateOnly />{/if}
				</DetailRow>
				<DetailRow label="Baselined">
					{#if req.baselined_at}
						<Timestamp value={req.baselined_at} />{req.baselined_by
							? ` by ${req.baselined_by}`
							: ''}
					{:else}<span class="text-muted-foreground">—</span>{/if}
				</DetailRow>
				<DetailRow label="Created"><Timestamp value={req.created_at} /></DetailRow>
				<DetailRow label="Updated"><Timestamp value={req.updated_at} /></DetailRow>
			</DetailTable>
		</div>
	</Section>

	{#if mutable && req.readiness}
		<Section title="BASELINE READINESS" count={failingHard ? `${failingHard} blocking` : 'clear'}>
			{#snippet actions()}
				<Button size="xs" disabled={!req.readiness?.ready} onclick={baselineIt}
					>BASELINE {req.req_number}</Button
				>
			{/snippet}
			<DataTable
				rows={req.readiness.checks}
				columns={[
					{ key: 'label', label: 'Check', width: '18rem' },
					{ key: 'passed', label: 'Result', width: '6rem' },
					{ key: 'detail', label: 'Detail' }
				]}
				key={(c) => c.key}
				emptyLabel="Checks"
				dense
			>
				{#snippet cell(c, col)}
					{#if col.key === 'label'}{c.label}
					{:else if col.key === 'passed'}
						{#if c.passed}<State value="pass" tone="ok" label="PASS" />
						{:else if c.severity === 'hard'}<State value="fail" tone="error" label="BLOCKS" />
						{:else}<State value="warn" tone="warn" label="WARNING" />{/if}
					{:else}
						<span class="text-xs {c.passed ? 'text-muted-foreground' : ''}">{c.detail ?? '—'}</span>
					{/if}
				{/snippet}
			</DataTable>
		</Section>
	{/if}

	{#if req.children.length}
		<Section title="FLOW-DOWN" count={req.children.length}>
			{#snippet actions()}
				{#if !terminal}<Button
						size="xs"
						variant="ghost"
						class="font-mono text-info"
						onclick={() => (qcOpen = true)}>+ FLOW DOWN</Button
					>{/if}
			{/snippet}
			<DataTable
				rows={req.children}
				columns={childColumns}
				href={(c) => `/requirements/${c.id}`}
				key={(c) => c.id}
				emptyLabel="Flow-down"
				dense
			>
				{#snippet cell(c, col)}
					{#if col.key === 'req_number'}<span class="text-info">{c.req_number}</span>
					{:else if col.key === 'lifecycle_state'}
						<State value={c.lifecycle_state} tone={lifecycleTone(c.lifecycle_state)} />
					{:else if col.key === 'stale'}
						{#if c.stale}<State value="stale" tone="warn" label="STALE" />{:else}<span
								class="text-muted-foreground">—</span
							>{/if}
					{:else if col.key === 'level'}{c.level}
					{:else}{c.title}{/if}
				{/snippet}
			</DataTable>
		</Section>
	{:else if !terminal}
		<EmptyLine label="Flow-down" onadd={() => (qcOpen = true)} addLabel="+ FLOW DOWN" />
	{/if}

	{#if req.allocations.length}
		<Section title="PARTS" count={req.allocations.length}>
			{#snippet actions()}
				{#if !terminal}<PartPicker
						onpick={assign}
						exclude={req.allocations.map((a) => a.part_id)}
					/>{/if}
			{/snippet}
			<DataTable
				rows={req.allocations}
				columns={allocColumns}
				key={(a) => a.id}
				emptyLabel="Parts"
				dense
			>
				{#snippet cell(a, col)}
					{#if col.key === 'part_name'}
						<a href={`/parts/${a.part_id}`} class="hover:underline">{a.part_name}</a>
					{:else if col.key === 'internal_pn'}
						<a href={`/parts/${a.part_id}`} class="text-info hover:underline"
							>{a.internal_pn ?? '—'}</a
						>
					{:else if col.key === 'status'}
						<NativeSelect
							size="sm"
							value={a.status}
							onchange={(e) => setStatus(a, e.currentTarget.value)}
							aria-label={`Verification of ${a.part_name}`}
						>
							<NativeSelectOption value="open">OPEN</NativeSelectOption>
							<NativeSelectOption value="verified">VERIFIED</NativeSelectOption>
							<NativeSelectOption value="waived">WAIVED</NativeSelectOption>
							<NativeSelectOption value="not_applicable">NOT APPLICABLE</NativeSelectOption>
						</NativeSelect>
					{:else if col.key === 'verified'}
						{#if a.verified_at}
							<span class="text-xs"
								><Timestamp value={a.verified_at} />{a.verified_by ? ` ${a.verified_by}` : ''}</span
							>
						{:else}<span class="text-muted-foreground">—</span>{/if}
						{#if a.outdated}<span
								class="ml-2 font-mono text-[11px] font-medium text-warn"
								title={`Closed against rev ${a.against_revision}; rev ${req.revision} is not verified`}
								>OUTDATED</span
							>{/if}
					{:else if col.key === 'against_revision'}
						<span
							class={a.against_revision !== req.revision ? 'text-warn' : ''}
							title={a.against_revision !== req.revision
								? `Assigned against rev ${a.against_revision}`
								: undefined}>{a.against_revision}</span
						>
					{:else if col.key === 'notes'}
						<Input
							class="h-7"
							value={a.notes ?? ''}
							onblur={(e) => setNotes(a, e.currentTarget.value)}
							aria-label={`Notes for ${a.part_name}`}
						/>
					{:else}
						<Button size="xs" variant="ghost" class="text-error" onclick={() => unassign(a)}
							>UNASSIGN</Button
						>
					{/if}
				{/snippet}
			</DataTable>
		</Section>
	{:else if !terminal}
		<EmptyLine label="Parts">
			{#snippet action()}<PartPicker onpick={assign} />{/snippet}
		</EmptyLine>
	{/if}

	<Section title="REVISIONS" count={req.revisions.length}>
		<DataTable
			rows={req.revisions}
			columns={revColumns}
			href={(r) => (r.id === req.id ? null : `/requirements/${r.id}`)}
			rowClass={(r) => (r.id === req.id ? 'bg-muted/60' : undefined)}
			key={(r) => r.id}
			emptyLabel="Revisions"
			dense
		>
			{#snippet cell(r, col)}
				{#if col.key === 'revision'}{r.revision}{r.id === req.id ? ' ◀' : ''}
				{:else if col.key === 'lifecycle_state'}
					<State value={r.lifecycle_state} tone={lifecycleTone(r.lifecycle_state)} />
				{:else if col.key === 'statement'}
					<span
						class="line-clamp-2 font-mono text-xs {r.lifecycle_state === 'superseded'
							? 'text-muted-foreground line-through'
							: ''}">{r.statement}</span
					>
				{:else}<Timestamp value={r.baselined_at} />{/if}
			{/snippet}
		</DataTable>
		{#if req.revisions.length > 1}
			<div class="grid gap-2 border-t border-border p-3">
				<div class="flex items-center gap-2">
					<span class="label">Redline</span>
					<NativeSelect size="sm" bind:value={revA} aria-label="Redline from revision">
						{#each req.revisions as r (r.id)}
							<NativeSelectOption value={r.revision}>rev {r.revision}</NativeSelectOption>
						{/each}
					</NativeSelect>
					<span class="font-mono text-muted-foreground">→</span>
					<NativeSelect size="sm" bind:value={revB} aria-label="Redline to revision">
						{#each req.revisions as r (r.id)}
							<NativeSelectOption value={r.revision}>rev {r.revision}</NativeSelectOption>
						{/each}
					</NativeSelect>
				</div>
				{#if redline}
					<DetailTable>
						<DetailRow label="Statement"><Redline segments={redline.statement} /></DetailRow>
						<DetailRow label="Rationale"><Redline segments={redline.rationale} /></DetailRow>
						<DetailRow label="Title"><Redline segments={redline.title} /></DetailRow>
					</DetailTable>
				{/if}
			</div>
		{/if}
	</Section>

	{#if req.baseline_events.length}
		<Section title="BASELINES" count={req.baseline_events.length}>
			<DataTable
				rows={req.baseline_events}
				columns={eventColumns}
				href={(e) => `/requirements/baselines/${e.event_id}`}
				key={(e) => e.event_id}
				emptyLabel="Baselines"
				dense
			>
				{#snippet cell(e, col)}
					{#if col.key === 'label'}
						<span class="mono">{e.label ?? '—'}</span>
					{:else if col.key === 'revision'}{e.revision}
					{:else}<Timestamp value={e.created_at} />{/if}
				{/snippet}
			</DataTable>
		</Section>
	{/if}
</div>

<QuickCreate
	bind:open={qcOpen}
	parent={{ id: req.id, req_number: req.req_number, level: req.level, category: req.category }}
	oncreated={() => invalidateAll()}
/>
