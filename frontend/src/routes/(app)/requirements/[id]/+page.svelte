<script lang="ts">
	import { cn } from '#lib/utils.js';
	import { goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import {
		ActionLink,
		DataTable,
		DetailRow,
		DetailTable,
		EditToggle,
		EmptyLine,
		MoreMenu,
		PageHeader,
		Section,
		State,
		Timestamp,
		askReason,
		confirm,
		isEditing,
		toast,
		toastError,
		type Column,
		type MoreItem
	} from '#lib/components/opal/index.js';
	import { opal } from '#lib/api.js';
	import { datetimeSec, stateLabel } from '#lib/format.js';
	import { session } from '#lib/session.svelte.js';
	import LintEditor from '#lib/components/requirements/LintEditor.svelte';
	import PartPicker from '#lib/components/parts/PartPicker.svelte';
	import QuickCreate from '#lib/components/requirements/QuickCreate.svelte';
	import ProjectRow from '#lib/components/projects/ProjectRow.svelte'; // added by projects
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
	const mutable = $derived(req.lifecycleState === 'draft' || req.lifecycleState === 'preliminary');
	const baselined = $derived(req.lifecycleState === 'baselined');
	const terminal = $derived(
		req.lifecycleState === 'superseded' || req.lifecycleState === 'cancelled'
	);
	// Pages open for reading. EDIT reveals the pencil of a draft: fields, parent, allocations.
	const editing = $derived(mutable && isEditing(page.url));
	// Verification is recorded per allocation on a baselined requirement, without editing it.
	/** A baselined requirement has no EDIT. Recording verification is its own deliberate act. */
	let recordingOpen = $state(false);
	const recording = $derived(editing || (baselined && recordingOpen));
	/** The newest revision of this number, when it is not this one. */
	const current = $derived(
		terminal
			? req.revisions.findLast((r) => r.id !== req.id && r.revision > req.revision)
			: undefined
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

	type Patch = Omit<Parameters<typeof opal.requirements.update>[0], 'id'>;

	async function save(patch: Patch) {
		try {
			await opal.requirements.update({ id: req.id, ...patch });
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
		save({ [field]: value.trim() === '' ? null : value } as Patch);
	}

	const nowIso = () => datetimeSec(new Date());
	const who = () => session.user?.name ?? 'unknown user';

	// ---- lifecycle actions ----
	async function baselineIt() {
		const ok = await confirm({
			title: `Baseline ${req.reqNumber} rev ${req.revision}`,
			body: `This locks the revision; later changes need a new revision. Signed ${who()} · ${nowIso()}.`,
			action: 'BASELINE'
		});
		if (!ok) return;
		try {
			await opal.requirements.baseline({ id: req.id });
			toast.success(`${req.reqNumber} baselined`);
			await invalidateAll();
		} catch (e) {
			toastError(e);
			await invalidateAll();
		}
	}

	async function revise() {
		try {
			const next = await opal.requirements.revise({ id: req.id });
			await goto(`/requirements/${next.id}`);
		} catch (e) {
			toastError(e);
		}
	}

	async function cancelIt() {
		const reason = await askReason({
			title: `Cancel ${req.reqNumber}`,
			body: 'Cancelled is terminal. The requirement stays on record and cannot be revised or baselined again.',
			action: 'CANCEL REQUIREMENT',
			destructive: true
		});
		if (reason === null) return;
		try {
			await opal.requirements.cancel({ id: req.id, reason });
			await invalidateAll();
		} catch (e) {
			toastError(e);
		}
	}

	async function deleteIt() {
		const ok = await confirm({
			title: `Delete ${req.reqNumber}?`,
			body: 'The draft is removed. Its number is not reused.',
			action: 'DELETE',
			destructive: true
		});
		if (!ok) return;
		try {
			await opal.requirements.delete({ id: req.id });
			await goto('/requirements');
		} catch (e) {
			toastError(e);
		}
	}

	async function reaffirm() {
		const ok = await confirm({
			title: `Re-affirm ${req.reqNumber}`,
			body: `The parent's change does not invalidate this requirement. Signed ${who()} · ${nowIso()}.`,
			action: 'RE-AFFIRM'
		});
		if (!ok) return;
		try {
			await opal.requirements.reaffirm({ id: req.id });
			await invalidateAll();
		} catch (e) {
			toastError(e);
		}
	}

	// ---- parts (allocations) ----
	async function assign(part: { id: number; name: string }) {
		try {
			await opal.requirements.assign({ partId: part.id, reqNumber: req.reqNumber });
			toast.success(`${part.name} assigned`);
			await invalidateAll();
		} catch (e) {
			toastError(e);
		}
	}

	async function setStatus(a: Allocation, status: string) {
		try {
			if (status === 'verified') await opal.requirements.verifyLink({ id: a.id });
			else await opal.requirements.updateLink({ id: a.id, status: status as Allocation['status'] });
		} catch (e) {
			toastError(e);
		}
		await invalidateAll();
	}

	async function setNotes(a: Allocation, notes: string) {
		if (notes === (a.notes ?? '')) return;
		try {
			await opal.requirements.updateLink({ id: a.id, notes });
			await invalidateAll();
		} catch (e) {
			toastError(e);
		}
	}

	async function unassign(a: Allocation) {
		const ok = await confirm({
			title: `Unassign ${a.partName} from ${req.reqNumber}?`,
			body: 'The part stops carrying this requirement and its verification record is removed.',
			action: 'UNASSIGN',
			destructive: true
		});
		if (!ok) return;
		try {
			await opal.requirements.unassign({ id: a.id });
			await invalidateAll();
		} catch (e) {
			toastError(e);
		}
	}

	const allocColumns: Column<Allocation>[] = [
		{ key: 'internalPn', label: 'PN', mono: true, width: '9rem' },
		{ key: 'partName', label: 'Name' },
		{ key: 'status', label: 'Verification', width: '10rem' },
		{ key: 'verified', label: 'Verified', width: '13rem' },
		{ key: 'againstRevision', label: 'Rev', mono: true, width: '4rem', align: 'right' },
		{ key: 'notes', label: 'Notes', width: '18rem' },
		{ key: 'actions', label: '', width: '6rem', align: 'right' }
	];

	// ---- flow-down ----
	let qcOpen = $state(false);
	const childColumns: Column<Dossier['children'][number]>[] = [
		{ key: 'reqNumber', label: 'Number', mono: true, width: '7rem' },
		{ key: 'title', label: 'Title' },
		{ key: 'lifecycleState', label: 'State', width: '8rem' },
		{ key: 'level', label: 'L', mono: true, width: '3rem', align: 'right' },
		{ key: 'stale', label: 'Flags', width: '6rem' }
	];

	// ---- revisions and redline ----
	const revColumns: Column<Dossier['revisions'][number]>[] = [
		{ key: 'revision', label: 'Rev', mono: true, width: '4rem' },
		{ key: 'lifecycleState', label: 'State', width: '8rem' },
		{ key: 'statement', label: 'Statement' },
		{ key: 'baselinedAt', label: 'Baselined', width: '10rem' }
	];
	let revA = $state(0);
	let revB = $state(0);
	let redline = $state<RedlineData | null>(null);
	$effect(() => {
		revA = req.predecessorRevision ?? req.revision;
		revB = req.revision;
	});
	$effect(() => {
		const [a, b, id] = [revA, revB, req.id];
		if (req.revisions.length < 2 || a === b || !a || !b) {
			redline = null;
			return;
		}
		opal.requirements
			.redline({ id, revA: a, revB: b })
			.then((r) => (redline = r))
			.catch(() => (redline = null));
	});

	const eventColumns: Column<Dossier['baselineEvents'][number]>[] = [
		{ key: 'createdAt', label: 'When', width: '10rem' },
		{ key: 'revision', label: 'Rev', mono: true, width: '4rem' },
		{ key: 'label', label: 'Label' }
	];

	const blocking = $derived(
		req.readiness?.checks.filter((c) => c.severity === 'hard' && !c.passed) ?? []
	);
	const failingHard = $derived(blocking.length);
	const blockedBy = $derived(
		blocking.length
			? `${blocking[0].label}${blocking.length > 1 ? ` +${blocking.length - 1}` : ''}`
			: ''
	);

	const moreItems = $derived<MoreItem[]>([
		{ label: 'RE-AFFIRM', onselect: reaffirm, when: req.stale && !terminal },
		{ label: 'DELETE', onselect: deleteIt, strike: true, when: mutable && req.canDelete },
		{ label: 'CANCEL', onselect: cancelIt, strike: true, when: mutable || baselined }
	]);
</script>

<PageHeader
	title={req.title}
	identifier={req.reqNumber}
	crumbs={[
		{ label: 'Requirements', href: '/requirements' },
		...req.parentChain.map((p) => ({ label: p.reqNumber, href: `/requirements/${p.id}` })),
		{ label: req.reqNumber }
	]}
>
	{#snippet heading()}
		<h1 class="min-w-0 text-lg font-semibold tracking-tight">
			{#if editing}
				<Input
					class="h-8 w-[min(60ch,60vw)] text-lg font-semibold"
					aria-label="Title"
					bind:value={title}
					maxlength={255}
					onblur={() => saveText('title', title)}
				/>
			{:else}{req.title}{/if}
		</h1>
	{/snippet}
	{#snippet state()}
		<State value={req.lifecycleState} tone={lifecycleTone(req.lifecycleState)} badge />
		<span class="mono text-xs text-muted-foreground">REV {req.revision}</span>
		{#if req.stale}
			<span
				class="font-mono text-xs font-medium text-warn"
				title="Parent was revised after this row last got a fresh look">STALE</span
			>
		{/if}
	{/snippet}
	{#snippet actions()}
		{#if mutable}
			<Button
				size="sm"
				disabled={!req.readiness?.ready}
				title={blockedBy || undefined}
				onclick={baselineIt}>BASELINE</Button
			>
			{#if blockedBy}
				<span class="font-mono text-xs text-muted-foreground" data-gate-reason="baseline"
					>{blockedBy}</span
				>
			{/if}
			<EditToggle />
		{:else if baselined}
			<Button size="sm" onclick={revise}>REVISE</Button>
		{:else if current}
			<Button size="sm" href={`/requirements/${current.id}`}>REV {current.revision}</Button>
		{/if}
		<MoreMenu items={moreItems} />
	{/snippet}
</PageHeader>

<div
	class={cn(
		'grid grid-cols-[minmax(0,1fr)] gap-4 p-4',
		req.lifecycleState === 'draft' && '[&_section]:border-dashed'
	)}
>
	<Section title="REQUIREMENT">
		<DetailTable>
			<ProjectRow id={req.projectId} code={req.projectCode} name={req.projectName} />
			<!-- added by projects -->
			<DetailRow label="Statement">
				{#if editing}
					<LintEditor
						bind:value={statement}
						findings={req.lint}
						onsave={(t) => saveText('statement', t)}
					/>
				{:else}
					<span>{req.statement}</span>
				{/if}
			</DetailRow>
			<DetailRow label="Rationale">
				{#if editing}
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
		<div
			class="grid grid-cols-1 items-start border-t border-border md:grid-cols-2 md:divide-x md:divide-border"
		>
			<DetailTable>
				<DetailRow label="Category">
					{#if editing}
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
					{#if editing}
						<NativeSelect
							class="w-full"
							value={String(req.parentId ?? '')}
							onchange={(e) =>
								save({ parentId: e.currentTarget.value ? Number(e.currentTarget.value) : null })}
							aria-label="Parent"
						>
							<NativeSelectOption value="">None (root)</NativeSelectOption>
							{#each data.parents as p (p.id)}
								<NativeSelectOption value={String(p.id)}>{p.reqNumber} {p.title}</NativeSelectOption
								>
							{/each}
						</NativeSelect>
					{:else if req.parentChain.length}
						{@const p = req.parentChain[req.parentChain.length - 1]}
						<a href={`/requirements/${p.id}`} class="hover:underline"
							><span class="mono text-info">{p.reqNumber}</span> {p.title}</a
						>
					{:else}<span class="text-muted-foreground">—</span>{/if}
				</DetailRow>
				<DetailRow label="Level">
					{#if editing}
						<NativeSelect
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
					{#if editing}
						<NativeSelect
							value={req.verificationMethod ?? ''}
							onchange={(e) =>
								save({
									verificationMethod: (e.currentTarget.value || null) as Patch['verificationMethod']
								})}
							aria-label="Verification method"
						>
							<NativeSelectOption value="">Not set</NativeSelectOption>
							{#each VERIFICATION_METHODS as m (m)}
								<NativeSelectOption value={m}>{m.toUpperCase()}</NativeSelectOption>
							{/each}
						</NativeSelect>
					{:else}<span class="mono">{req.verificationMethod?.toUpperCase() ?? '—'}</span>{/if}
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
					{#if editing}
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
					{#if editing}
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
					{#if editing}
						<NativeSelect
							value={String(req.tbrOwnerId ?? '')}
							onchange={(e) =>
								save({
									tbrOwnerId: e.currentTarget.value ? Number(e.currentTarget.value) : null
								})}
							aria-label="TBR owner"
						>
							<NativeSelectOption value="">Not set</NativeSelectOption>
							{#each data.assignees as u (u.id)}
								<NativeSelectOption value={String(u.id)}>{u.name}</NativeSelectOption>
							{/each}
						</NativeSelect>
					{:else}{req.tbrOwner ?? '—'}{/if}
				</DetailRow>
				<DetailRow label="TBR due">
					{#if editing}
						<Input
							type="date"
							class="h-7 w-40 font-mono"
							value={req.tbrDue?.slice(0, 10) ?? ''}
							onchange={(e) =>
								save({
									tbrDue: e.currentTarget.value ? `${e.currentTarget.value}T00:00:00Z` : null
								})}
							aria-label="TBR due"
						/>
					{:else}<Timestamp value={req.tbrDue} dateOnly />{/if}
				</DetailRow>
				{#if req.lifecycleState === 'cancelled'}
					<DetailRow label="Cancelled">
						<Timestamp value={req.cancelledAt} />{req.cancelledBy ? ` by ${req.cancelledBy}` : ''}
					</DetailRow>
					<DetailRow label="Reason" value={req.cancelReason} />
				{/if}
				<DetailRow label="Baselined">
					{#if req.baselinedAt}
						<Timestamp value={req.baselinedAt} />{req.baselinedBy ? ` by ${req.baselinedBy}` : ''}
					{:else}<span class="text-muted-foreground">—</span>{/if}
				</DetailRow>
				<DetailRow label="Created"><Timestamp value={req.createdAt} /></DetailRow>
				<DetailRow label="Updated"><Timestamp value={req.updatedAt} /></DetailRow>
			</DetailTable>
		</div>
	</Section>

	{#if mutable && req.readiness}
		<Section title="BASELINE READINESS" count={failingHard ? `${failingHard} blocking` : 'clear'}>
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
				{#if mutable}<ActionLink onclick={() => (qcOpen = true)}>+ FLOW DOWN</ActionLink>{/if}
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
					{#if col.key === 'reqNumber'}<span class="text-info">{c.reqNumber}</span>
					{:else if col.key === 'lifecycleState'}
						<State value={c.lifecycleState} tone={lifecycleTone(c.lifecycleState)} />
					{:else if col.key === 'stale'}
						{#if c.stale}<State value="stale" tone="warn" label="STALE" />{:else}<span
								class="text-muted-foreground">—</span
							>{/if}
					{:else if col.key === 'level'}{c.level}
					{:else}{c.title}{/if}
				{/snippet}
			</DataTable>
		</Section>
	{:else}
		<EmptyLine
			label="Flow-down"
			onadd={mutable ? () => (qcOpen = true) : undefined}
			addLabel="+ FLOW DOWN"
		/>
	{/if}

	{#if req.allocations.length}
		<Section title="PARTS" count={req.allocations.length}>
			{#snippet actions()}
				{#if editing}<PartPicker
						align="end"
						trigger={assignPart}
						onselect={(p) => p && assign(p)}
						exclude={req.allocations.map((a) => a.partId)}
					/>{/if}
				{#if baselined}<ActionLink onclick={() => (recordingOpen = !recordingOpen)}
						>{recordingOpen ? 'DONE' : 'RECORD VERIFICATION'}</ActionLink
					>{/if}
			{/snippet}
			<DataTable
				rows={req.allocations}
				columns={allocColumns}
				key={(a) => a.id}
				emptyLabel="Parts"
				dense
			>
				{#snippet cell(a, col)}
					{#if col.key === 'partName'}
						<a href={`/parts/${a.partId}`} class="hover:underline">{a.partName}</a>
					{:else if col.key === 'internalPn'}
						<a href={`/parts/${a.partId}`} class="text-info hover:underline"
							>{a.internalPn ?? '—'}</a
						>
					{:else if col.key === 'status'}
						{#if recording}
							<NativeSelect
								value={a.status}
								onchange={(e) => setStatus(a, e.currentTarget.value)}
								aria-label={`Verification of ${a.partName}`}
							>
								<NativeSelectOption value="open">OPEN</NativeSelectOption>
								<NativeSelectOption value="verified">VERIFIED</NativeSelectOption>
								<NativeSelectOption value="waived">WAIVED</NativeSelectOption>
								<NativeSelectOption value="not_applicable">NOT APPLICABLE</NativeSelectOption>
							</NativeSelect>
						{:else}
							<span class="font-mono text-xs">{stateLabel(a.status)}</span>
						{/if}
					{:else if col.key === 'verified'}
						{#if a.verifiedAt}
							<span class="text-xs"
								><Timestamp value={a.verifiedAt} />{a.verifiedBy ? ` ${a.verifiedBy}` : ''}</span
							>
						{:else}<span class="text-muted-foreground">—</span>{/if}
						{#if a.outdated}<span
								class="ml-2 font-mono text-xs font-medium text-warn"
								title={`Closed against rev ${a.againstRevision}; rev ${req.revision} is not verified`}
								>OUTDATED</span
							>{/if}
					{:else if col.key === 'againstRevision'}
						<span
							class={a.againstRevision !== req.revision ? 'text-warn' : ''}
							title={a.againstRevision !== req.revision
								? `Assigned against rev ${a.againstRevision}`
								: undefined}>{a.againstRevision}</span
						>
					{:else if col.key === 'notes'}
						{#if recording}
							<Input
								class="h-7"
								value={a.notes ?? ''}
								onblur={(e) => setNotes(a, e.currentTarget.value)}
								aria-label={`Notes for ${a.partName}`}
							/>
						{:else}{a.notes ?? '—'}{/if}
					{:else if editing}
						<ActionLink onclick={() => unassign(a)}>UNASSIGN</ActionLink>
					{/if}
				{/snippet}
			</DataTable>
		</Section>
	{:else if editing}
		<EmptyLine label="Parts">
			{#snippet action()}<PartPicker
					align="end"
					trigger={assignPart}
					onselect={(p) => p && assign(p)}
				/>{/snippet}
		</EmptyLine>
	{:else}
		<EmptyLine label="Parts" />
	{/if}

	<Section title="REVISIONS" count={req.revisions.length}>
		{#snippet actions()}
			<ActionLink href={`/audit?entity=requirement&record=${req.id}`}>AUDIT</ActionLink>
		{/snippet}
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
				{:else if col.key === 'lifecycleState'}
					<State value={r.lifecycleState} tone={lifecycleTone(r.lifecycleState)} />
				{:else if col.key === 'statement'}
					<span
						class="line-clamp-2 {r.lifecycleState === 'superseded'
							? 'text-muted-foreground line-through'
							: ''}">{r.statement}</span
					>
				{:else}<Timestamp value={r.baselinedAt} />{/if}
			{/snippet}
		</DataTable>
		{#if req.revisions.length > 1}
			<div class="grid grid-cols-1 gap-2 border-t border-border p-3">
				<div class="flex items-center gap-2">
					<span class="label">Redline</span>
					<NativeSelect bind:value={revA} aria-label="Redline from revision">
						{#each req.revisions as r (r.id)}
							<NativeSelectOption value={r.revision}>rev {r.revision}</NativeSelectOption>
						{/each}
					</NativeSelect>
					<span class="font-mono text-muted-foreground">→</span>
					<NativeSelect bind:value={revB} aria-label="Redline to revision">
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

	{#if req.baselineEvents.length}
		<Section title="BASELINES" count={req.baselineEvents.length}>
			<DataTable
				rows={req.baselineEvents}
				columns={eventColumns}
				href={(e) => `/requirements/baselines/${e.eventId}`}
				key={(e) => e.eventId}
				emptyLabel="Baselines"
				dense
			>
				{#snippet cell(e, col)}
					{#if col.key === 'label'}
						<span class="mono">{e.label ?? '—'}</span>
					{:else if col.key === 'revision'}{e.revision}
					{:else}<Timestamp value={e.createdAt} />{/if}
				{/snippet}
			</DataTable>
		</Section>
	{/if}
</div>

<QuickCreate
	bind:open={qcOpen}
	parent={{
		id: req.id,
		reqNumber: req.reqNumber,
		level: req.level,
		category: req.category,
		projectId: req.projectId // added by projects
	}}
	oncreated={() => invalidateAll()}
/>

{#snippet assignPart({ props }: { props: Record<string, unknown> })}
	<ActionLink {...props}>+ ASSIGN PART</ActionLink>
{/snippet}
