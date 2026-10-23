<script lang="ts">
	import { goto, invalidate } from '$app/navigation';
	import { api } from '#lib/api.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import {
		DataTable,
		DetailRow,
		DetailTable,
		EmptyLine,
		EntityPicker,
		PageHeader,
		Section,
		State,
		Timestamp,
		confirm,
		toast,
		toastError,
		type Column,
		Avatar
	} from '#lib/components/opal/index.js';
	import PartPicker from '#lib/components/parts/PartPicker.svelte';
	import { searchKind } from '#lib/components/issues/pickers.js';
	import InlineText from '#lib/components/issues/InlineText.svelte';
	import {
		CONTAINMENTS,
		CONTAINMENT_OPTION,
		DISPOSITIONS,
		ISSUE_TYPES,
		PRIORITIES,
		kb,
		ticketLabel,
		ticketTone,
		type Attachment,
		type Issue
	} from '#lib/components/issues/issues.js';
	import { session } from '#lib/session.svelte.js';
	import { markdown } from '#lib/markdown.js';
	import { stateLabel } from '#lib/format.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const issue = $derived(data.issue);
	const bearing = $derived(issue.containment !== 'advisory');
	const closed = $derived(issue.status === 'closed');
	const type = $derived(issue.issue_type);

	const refresh = () => invalidate('issue:detail');

	/** PATCH one or more fields; reload the page data. */
	async function patch(fields: Record<string, unknown>) {
		await api.patch(`/issues/${issue.id}`, fields);
		await refresh();
	}

	async function act(fn: () => Promise<unknown>) {
		try {
			await fn();
		} catch (e) {
			toastError(e);
			await refresh();
		}
	}

	// ---- Header actions ----
	const needsCorrective = $derived(
		issue.issue_type === 'non_conformance' && !issue.corrective_action?.trim()
	);
	const ticket = $derived(issue.ticket_state);
	// Work starts at the signed disposition for containment-bearing issues.
	const startedAt = $derived(bearing ? issue.dispositioned_at : issue.work_started_at);
	const startedBy = $derived(bearing ? issue.dispositioned_by_name : issue.work_started_by_name);

	const transition = (path: string, body?: unknown) =>
		act(async () => {
			await api.post(`/issues/${issue.id}/${path}`, body);
			await refresh();
		});

	let returning = $state(false);
	let returnComment = $state('');
	let returnBusy = $state(false);
	async function submitReturn() {
		if (!returnComment.trim()) return;
		returnBusy = true;
		try {
			await api.post(`/issues/${issue.id}/review/return`, { comment: returnComment.trim() });
			returning = false;
			returnComment = '';
			await refresh();
		} catch (e) {
			toastError(e);
		} finally {
			returnBusy = false;
		}
	}

	async function reopen() {
		await act(() => patch({ status: 'open' }));
	}
	async function remove() {
		const ok = await confirm({
			title: `Delete ${issue.issue_number}`,
			body:
				bearing && !issue.dispositioned
					? 'Deleting this issue releases every hold it places. Comments and attachments are removed from view.'
					: 'The issue disappears from lists and search. Comments and attachments are removed from view.',
			action: 'DELETE',
			destructive: true
		});
		if (!ok) return;
		await act(async () => {
			await api.del(`/issues/${issue.id}`);
			toast.success(`${issue.issue_number} deleted`);
			await goto('/issues');
		});
	}

	// ---- Containment ----
	const RANK: Record<string, number> = { advisory: 0, step: 1, op: 2, wo: 3 };
	let noteFor = $state<string | null>(null);
	let note = $state('');
	let noteBusy = $state(false);
	// Holds after the proposed narrowing, from the same readout the Holds section uses.
	let preview = $state<{ label: string }[]>([]);
	const holdNames = (h: { label: string }[]) => h.map((x) => x.label).join(' · ');

	async function setContainment(e: Event & { currentTarget: HTMLSelectElement }) {
		const next = e.currentTarget.value;
		const select = e.currentTarget;
		if (next === issue.containment) return;
		const narrowing = RANK[next] < RANK[issue.containment];
		if (narrowing && issue.disp_state === 'undispositioned') {
			select.value = issue.containment;
			note = '';
			preview = [];
			noteFor = next;
			try {
				preview = await api.get<{ label: string }[]>(
					`/issues/${issue.id}/holding?containment=${next}`
				);
			} catch (err) {
				toastError(err);
			}
			return;
		}
		try {
			await api.post(`/issues/${issue.id}/containment`, { containment: next });
			await refresh();
		} catch (err) {
			toastError(err);
			select.value = issue.containment;
		}
	}

	async function commitNarrowing() {
		if (!noteFor || !note.trim()) return;
		noteBusy = true;
		try {
			await api.post(`/issues/${issue.id}/containment`, {
				containment: noteFor,
				note: note.trim()
			});
			noteFor = null;
			await refresh();
		} catch (err) {
			toastError(err);
		} finally {
			noteBusy = false;
		}
	}

	async function setBoundary(e: Event & { currentTarget: HTMLSelectElement }) {
		const v = e.currentTarget.value;
		await act(async () => {
			await api.post(`/issues/${issue.id}/containment`, {
				containment: issue.containment,
				containment_step_id: v ? Number(v) : null
			});
			await refresh();
		});
	}

	// ---- Disposition ----
	let dispType = $state('');
	let dispRationale = $state('');
	let dispBusy = $state(false);
	// Seed the draft from the server and re-seed when the issue changes.
	let seededFor = $state<string>('');
	$effect(() => {
		const key = `${issue.id}:${issue.updated_at}`;
		if (key !== seededFor) {
			seededFor = key;
			dispType = issue.disposition_type ?? '';
			dispRationale = issue.disposition_rationale ?? '';
		}
	});

	async function saveDraft() {
		if (issue.dispositioned) return;
		const changes: Record<string, unknown> = {};
		if (dispType !== (issue.disposition_type ?? '')) changes.disposition_type = dispType;
		if (dispRationale !== (issue.disposition_rationale ?? ''))
			changes.disposition_rationale = dispRationale;
		if (!Object.keys(changes).length) return;
		await act(() => patch(changes));
	}

	async function sign() {
		if (!dispType || !dispRationale.trim()) return;
		dispBusy = true;
		try {
			const holds = await api.get<{ label: string }[]>(`/issues/${issue.id}/holding`);
			const ok = await confirm({
				title: `Sign disposition of ${issue.issue_number}`,
				body: `${stateLabel(dispType)} signed by ${session.user?.name ?? 'you'}. ${
					holds.length ? `Releases ${holds.map((h) => h.label).join(' · ')}.` : 'Nothing is held.'
				} A signed disposition cannot be edited.`,
				action: 'SIGN'
			});
			if (!ok) return;
			await api.post(`/issues/${issue.id}/disposition`, {
				disposition_type: dispType,
				disposition_rationale: dispRationale.trim()
			});
			await refresh();
		} catch (e) {
			toastError(e);
		} finally {
			dispBusy = false;
		}
	}

	// ---- Links ----
	async function link(
		field: 'part_id' | 'procedure_id' | 'procedure_instance_id',
		id: number | null
	) {
		await act(() => patch({ [field]: id }));
	}

	// ---- Risks ----
	let linkingRisk = $state(false);
	let riskRole = $state('mitigation');
	async function linkRisk(riskId: number) {
		await act(async () => {
			await api.post(`/risks/${riskId}/issues`, { issue_id: issue.id, role: riskRole });
			linkingRisk = false;
			await refresh();
		});
	}
	async function unlinkRisk(riskId: number, number: string) {
		const ok = await confirm({
			title: `Unlink ${number}`,
			body: `${issue.issue_number} stops counting as a response to ${number}.`,
			action: 'UNLINK',
			destructive: true
		});
		if (!ok) return;
		await act(async () => {
			await api.del(`/risks/${riskId}/issues/${issue.id}`);
			await refresh();
		});
	}

	// ---- Comments ----
	let comment = $state('');
	let commentBusy = $state(false);
	async function postComment() {
		if (!comment.trim()) return;
		commentBusy = true;
		try {
			await api.post(`/issues/${issue.id}/comments`, { body: comment.trim() });
			comment = '';
			await refresh();
		} catch (e) {
			toastError(e);
		} finally {
			commentBusy = false;
		}
	}

	// ---- Attachments ----
	let fileInput = $state<HTMLInputElement | null>(null);
	let cameraInput = $state<HTMLInputElement | null>(null);
	let uploading = $state(false);

	async function upload(files: FileList | null) {
		if (!files?.length) return;
		uploading = true;
		const failed: string[] = [];
		for (const file of files) {
			const fd = new FormData();
			fd.append('file', file);
			fd.append('issue_id', String(issue.id));
			try {
				await api.post('/attachments/upload', fd);
			} catch (e) {
				failed.push(`${file.name}: ${e instanceof Error ? e.message : 'failed'}`);
			}
		}
		uploading = false;
		if (fileInput) fileInput.value = '';
		if (cameraInput) cameraInput.value = '';
		if (failed.length) toastError(new Error(`Upload failed — ${failed.join('; ')}`));
		await refresh();
	}

	async function removeAttachment(a: Attachment) {
		const ok = await confirm({
			title: `Delete ${a.original_filename}`,
			body: 'The file is removed from the server.',
			action: 'DELETE',
			destructive: true
		});
		if (!ok) return;
		await act(async () => {
			await api.del(`/attachments/${a.id}`);
			await refresh();
		});
	}

	const attachmentColumns: Column<Attachment>[] = [
		{ key: 'file', label: 'File' },
		{ key: 'type', label: 'Type', width: '9rem' },
		{ key: 'size', label: 'Size', width: '6rem', align: 'right', mono: true },
		{ key: 'by', label: 'Added by', width: '9rem' },
		{ key: 'at', label: 'Added', width: '9rem' },
		{ key: 'actions', label: '', width: '5rem', align: 'right' }
	];

	const riskRoleLabel = (r: string) => stateLabel(r);
	const typeFields = $derived({
		nc: type === 'non_conformance',
		bug: type === 'bug',
		improvement: type === 'improvement'
	});
	const redlineHref = $derived(
		issue.procedure_instance_id && issue.raised_op_order !== null
			? `/executions/${issue.procedure_instance_id}?op=${issue.raised_op_order}&redline_issue=${issue.id}`
			: null
	);
	const hasRedlineAction = $derived(
		issue.dispositioned &&
			['rework', 'repair'].includes(issue.disposition_type ?? '') &&
			!!redlineHref
	);

	// Gate flags come from the server per viewer; absent means allowed.
	const cannotApprove = $derived(issue.can_approve === false);
	const cannotDisposition = $derived(issue.can_disposition === false);

	function text(field: keyof Issue) {
		return async (v: string | null) => patch({ [field]: v ?? '' });
	}
</script>

{#snippet stamp(by: string | null, at: string | null)}
	{#if at}
		{by ?? '—'} · <Timestamp value={at} />
	{:else}
		<span class="text-muted-foreground">—</span>
	{/if}
{/snippet}

{#snippet textRow(
	label: string,
	field: keyof Issue,
	opts?: { required?: boolean; rich?: boolean; hint?: string }
)}
	<DetailRow {label}>
		<InlineText
			{label}
			value={issue[field] as string | null}
			multiline
			rich={opts?.rich ?? true}
			hint={opts?.hint}
			onsave={text(field)}
		/>
	</DetailRow>
{/snippet}

<PageHeader
	title={issue.title}
	identifier={issue.issue_number}
	crumbs={[{ label: 'Issues', href: '/issues' }, { label: issue.issue_number ?? 'Issue' }]}
>
	{#snippet heading()}
		<h1 class="min-w-0 text-lg font-semibold tracking-tight [&>div]:items-center">
			<InlineText label="Title" value={issue.title} required onsave={text('title')} />
		</h1>
	{/snippet}
	{#snippet state()}
		<State value={ticket} label={ticketLabel(ticket)} tone={ticketTone(ticket)} badge />
	{/snippet}
	{#snippet actions()}
		<Button size="sm" variant="ghost" href={`/audit?entity=issue&record=${issue.id}`}>AUDIT</Button>
		{#if ticket === 'done'}
			<Button size="sm" variant="outline" onclick={reopen}>REOPEN</Button>
		{:else if ticket === 'pending' && !bearing}
			<Button size="sm" onclick={() => transition('start')}>START WORK</Button>
		{:else if ticket === 'in_work'}
			<Button size="sm" onclick={() => transition('review')}>SUBMIT FOR REVIEW</Button>
		{:else if ticket === 'in_review'}
			<Button
				size="sm"
				disabled={needsCorrective || cannotApprove}
				title={cannotApprove
					? issue.gate_reasons?.approve
					: needsCorrective
						? 'Corrective action is required to sign off'
						: undefined}
				onclick={() => transition('signoff')}>SIGN OFF</Button
			>
			{#if cannotApprove}
				<span class="font-mono text-xs text-muted-foreground" data-gate-reason="approve"
					>{issue.gate_reasons?.approve ?? 'Requires approval role'}</span
				>
			{/if}
			<Button size="sm" variant="outline" onclick={() => (returning = true)}>RETURN</Button>
		{/if}
		<Button size="sm" variant="destructive" onclick={remove}>DELETE</Button>
	{/snippet}
</PageHeader>

<div class="grid grid-cols-1 gap-4 p-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
	<div class="grid grid-cols-1 content-start gap-4">
		<Section title="Details">
			<DetailTable>
				{@render textRow('Description', 'description')}
				{#if typeFields.nc || issue.should_be || issue.actual}
					{@render textRow('Should be', 'should_be')}
					{@render textRow('Is', 'actual')}
				{/if}
				{#if typeFields.bug || issue.steps_to_reproduce || issue.expected_behavior || issue.actual_behavior}
					{@render textRow('Steps to reproduce', 'steps_to_reproduce')}
					{@render textRow('Expected behavior', 'expected_behavior')}
					{@render textRow('Actual behavior', 'actual_behavior')}
				{/if}
				{#if typeFields.improvement || issue.expected_benefit}
					{@render textRow('Expected benefit', 'expected_benefit')}
				{/if}
				{#if typeFields.nc || typeFields.bug || issue.root_cause || issue.corrective_action}
					{@render textRow('Root cause', 'root_cause')}
					{@render textRow('Corrective action', 'corrective_action', {
						hint: typeFields.nc && !closed ? 'required for sign-off' : undefined
					})}
				{/if}
			</DetailTable>
		</Section>

		{#if issue.dispositioned || (bearing && !closed)}
			<Section title="Disposition">
				{#snippet actions()}
					{#if issue.self_dispositioned}
						<State value="self_dispositioned" tone="warn" badge label="SELF-DISPOSITIONED" />
					{/if}
				{/snippet}
				<DetailTable>
					{#if issue.dispositioned}
						<DetailRow label="Type" mono value={stateLabel(issue.disposition_type)} />
						<DetailRow label="Rationale">
							<!-- eslint-disable-next-line svelte/no-at-html-tags -->
							<div class="prose-opal">{@html markdown(issue.disposition_rationale)}</div>
						</DetailRow>
						<DetailRow label="Signed by">
							{issue.dispositioned_by_name ?? '—'} ·
							<Timestamp value={issue.dispositioned_at} />
						</DetailRow>
						{#if hasRedlineAction && redlineHref}
							<DetailRow label="Redline">
								<Button size="xs" variant="outline" href={redlineHref}>SPAWN REDLINE OP</Button>
							</DetailRow>
						{/if}
					{:else}
						<DetailRow label="Type">
							<NativeSelect
								size="sm"
								aria-label="Disposition type"
								bind:value={dispType}
								onchange={saveDraft}
								class="w-56"
							>
								<NativeSelectOption value="">—</NativeSelectOption>
								{#each DISPOSITIONS as d (d)}
									<NativeSelectOption value={d}>{stateLabel(d)}</NativeSelectOption>
								{/each}
							</NativeSelect>
						</DetailRow>
						<DetailRow label="Rationale">
							<Textarea
								bind:value={dispRationale}
								rows={3}
								aria-label="Disposition rationale"
								onblur={saveDraft}
							/>
						</DetailRow>
						<DetailRow label="Signature">
							<Button
								size="sm"
								disabled={dispBusy || cannotDisposition || !dispType || !dispRationale.trim()}
								title={cannotDisposition
									? issue.gate_reasons?.disposition
									: !dispType || !dispRationale.trim()
										? `missing: ${[!dispType && 'type', !dispRationale.trim() && 'rationale'].filter(Boolean).join(', ')}`
										: undefined}
								onclick={sign}>SIGN DISPOSITION</Button
							>
							{#if cannotDisposition}
								<span
									class="ml-2 font-mono text-xs text-muted-foreground"
									data-gate-reason="disposition"
									>{issue.gate_reasons?.disposition ?? 'Requires disposition role'}</span
								>
							{/if}
						</DetailRow>
					{/if}
				</DetailTable>
			</Section>
		{/if}

		<Section title="Comments" count={data.comments.length || undefined}>
			{#if data.comments.length}
				<ul class="divide-y divide-border">
					{#each data.comments as c (c.id)}
						<li class="px-3 py-2">
							<div class="mb-0.5 flex items-baseline gap-2 text-xs">
								{#if c.user_id}<Avatar
										user={{ id: c.user_id, name: c.user_name, avatar_url: c.user_avatar_url }}
										size="xs"
									/>{/if}
								<span class="font-medium">{c.user_name ?? 'System'}</span>
								<Timestamp value={c.created_at} />
							</div>
							<!-- eslint-disable-next-line svelte/no-at-html-tags -->
							<div class="prose-opal text-sm">{@html markdown(c.body)}</div>
						</li>
					{/each}
				</ul>
			{/if}
			<form
				class="grid grid-cols-1 gap-1.5 border-t border-border p-3 first:border-t-0"
				onsubmit={(e) => {
					e.preventDefault();
					postComment();
				}}
			>
				<Label for="comment">Comment</Label>
				<Textarea
					id="comment"
					bind:value={comment}
					rows={3}
					onkeydown={(e) => {
						if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
							e.preventDefault();
							postComment();
						}
					}}
				/>
				<div>
					<Button type="submit" size="sm" disabled={commentBusy || !comment.trim()}>POST</Button>
				</div>
			</form>
		</Section>

		{#snippet addFiles()}
			<Button size="xs" variant="outline" disabled={uploading} onclick={() => fileInput?.click()}>
				+ ADD FILE
			</Button>
			<Button size="xs" variant="outline" disabled={uploading} onclick={() => cameraInput?.click()}>
				CAMERA
			</Button>
		{/snippet}
		<input
			bind:this={fileInput}
			type="file"
			multiple
			class="hidden"
			aria-label="Choose files"
			onchange={(e) => upload(e.currentTarget.files)}
		/>
		<input
			bind:this={cameraInput}
			type="file"
			accept="image/*"
			capture="environment"
			class="hidden"
			aria-label="Take photo"
			onchange={(e) => upload(e.currentTarget.files)}
		/>
		{#if data.attachments.length}
			<Section title="Attachments" count={data.attachments.length}>
				{#snippet actions()}{@render addFiles()}{/snippet}
				<DataTable
					rows={data.attachments}
					columns={attachmentColumns}
					emptyLabel="Attachments"
					key={(a) => a.id}
				>
					{#snippet cell(a, col)}
						{#if col.key === 'file'}
							<a
								href={`/api/attachments/${a.id}/download`}
								class="font-mono text-info hover:underline"
								download>{a.original_filename}</a
							>
						{:else if col.key === 'type'}
							<span class="font-mono text-xs text-muted-foreground">{a.mime_type}</span>
						{:else if col.key === 'size'}
							{kb(a.size_bytes)}
						{:else if col.key === 'by'}
							{a.uploaded_by_name ?? '—'}
						{:else if col.key === 'at'}
							<Timestamp value={a.created_at} />
						{:else}
							<button
								type="button"
								class="font-mono text-xs tracking-wider text-error uppercase hover:underline"
								onclick={() => removeAttachment(a)}>DELETE</button
							>
						{/if}
					{/snippet}
				</DataTable>
			</Section>
		{:else}
			<EmptyLine label="Attachments" action={addFiles} />
		{/if}
	</div>

	<div class="grid grid-cols-1 content-start gap-4">
		<Section title="Issue">
			<DetailTable>
				<DetailRow label="Type">
					<NativeSelect
						size="sm"
						aria-label="Type"
						value={issue.issue_type}
						onchange={(e) => act(() => patch({ issue_type: e.currentTarget.value }))}
					>
						{#each ISSUE_TYPES as t (t)}<NativeSelectOption value={t}
								>{stateLabel(t)}</NativeSelectOption
							>{/each}
					</NativeSelect>
				</DetailRow>
				<DetailRow label="Priority">
					<NativeSelect
						size="sm"
						aria-label="Priority"
						value={issue.priority}
						onchange={(e) => act(() => patch({ priority: e.currentTarget.value }))}
					>
						{#each PRIORITIES as p (p)}<NativeSelectOption value={p}
								>{stateLabel(p)}</NativeSelectOption
							>{/each}
					</NativeSelect>
				</DetailRow>
				<DetailRow label="Containment">
					<NativeSelect
						size="sm"
						aria-label="Containment"
						value={issue.containment}
						onchange={setContainment}
						disabled={closed}
					>
						{#each CONTAINMENTS as c (c)}<NativeSelectOption value={c}
								>{CONTAINMENT_OPTION[c]}</NativeSelectOption
							>{/each}
					</NativeSelect>
				</DetailRow>
				<DetailRow label="Assigned to">
					<NativeSelect
						size="sm"
						aria-label="Assigned to"
						value={issue.assigned_to_id === null ? '' : String(issue.assigned_to_id)}
						onchange={(e) =>
							act(() =>
								patch({
									assigned_to_id: e.currentTarget.value ? Number(e.currentTarget.value) : null
								})
							)}
					>
						<NativeSelectOption value="">Unassigned</NativeSelectOption>
						{#each data.assignees as a (a.id)}
							<NativeSelectOption value={String(a.id)}>{a.name}</NativeSelectOption>
						{/each}
					</NativeSelect>
				</DetailRow>
				<DetailRow label="Raised by" value={issue.raised_by_name} />
				<DetailRow label="Created"><Timestamp value={issue.created_at} /></DetailRow>
				<DetailRow label="Work started">
					{@render stamp(startedBy, startedAt)}
				</DetailRow>
				<DetailRow label="Review requested">
					{@render stamp(issue.review_requested_by_name, issue.review_requested_at)}
				</DetailRow>
				<DetailRow label="Closed">
					{@render stamp(issue.closed_by_name, issue.closed_at)}
				</DetailRow>
				<DetailRow label="Updated"><Timestamp value={issue.updated_at} /></DetailRow>
			</DetailTable>
		</Section>

		{#if bearing}
			{#if data.holding.length}
				<Section title="Holds" count={data.holding.length}>
					<ul class="divide-y divide-border">
						{#each data.holding as h (h.label)}
							<li class="px-3 py-1.5 font-mono text-xs">
								<a href={h.href} class="text-info hover:underline">{h.label}</a>
							</li>
						{/each}
					</ul>
				</Section>
			{:else}
				<EmptyLine label="Holds" />
			{/if}
		{/if}

		<Section title="Links">
			<DetailTable>
				<DetailRow label="Part">
					<div class="flex min-w-0 flex-wrap items-baseline gap-x-2">
						{#if issue.part_id}
							<a
								href={`/parts/${issue.part_id}`}
								class="font-mono whitespace-nowrap text-info hover:underline"
								>{issue.part_number ?? issue.part_name}</a
							>
							<span class="min-w-0 truncate text-muted-foreground">{issue.part_name}</span>
						{:else}<span class="text-muted-foreground">—</span>{/if}
						<span class="ml-auto flex gap-2 font-mono text-xs tracking-wider uppercase">
							<PartPicker align="end" onselect={(p) => p && link('part_id', p.id)}>
								{#snippet trigger({ props })}
									<button {...props} type="button" class="text-info hover:underline"
										>{issue.part_id ? 'CHANGE' : 'SET'}</button
									>
								{/snippet}
							</PartPicker>
							{#if issue.part_id}<button
									type="button"
									class="text-info hover:underline"
									onclick={() => link('part_id', null)}>CLEAR</button
								>{/if}
						</span>
					</div>
				</DetailRow>
				<DetailRow label="Procedure">
					<div class="flex min-w-0 flex-wrap items-baseline gap-x-2">
						{#if issue.procedure_id}
							<a href={`/procedures/${issue.procedure_id}`} class="text-info hover:underline"
								>{issue.procedure_name}</a
							>
						{:else}<span class="text-muted-foreground">—</span>{/if}
						<span class="ml-auto flex gap-2 font-mono text-xs tracking-wider uppercase">
							<EntityPicker
								label="Search procedures"
								placeholder="Search procedures"
								align="end"
								search={searchKind('procedure')}
								onpick={(o) => link('procedure_id', o.value)}
							>
								{#snippet trigger({ props })}
									<button {...props} type="button" class="text-info hover:underline"
										>{issue.procedure_id ? 'CHANGE' : 'SET'}</button
									>
								{/snippet}
							</EntityPicker>
							{#if issue.procedure_id}<button
									type="button"
									class="text-info hover:underline"
									onclick={() => link('procedure_id', null)}>CLEAR</button
								>{/if}
						</span>
					</div>
				</DetailRow>
				<DetailRow label="Execution">
					<div class="flex min-w-0 flex-wrap items-baseline gap-x-2">
						{#if issue.procedure_instance_id}
							<a
								href={`/executions/${issue.procedure_instance_id}`}
								class="font-mono text-info hover:underline">{issue.work_order_number}</a
							>
						{:else}<span class="text-muted-foreground">—</span>{/if}
						<span class="ml-auto flex gap-2 font-mono text-xs tracking-wider uppercase">
							<EntityPicker
								label="Search executions"
								placeholder="Search executions"
								align="end"
								search={searchKind('execution')}
								onpick={(o) => link('procedure_instance_id', o.value)}
							>
								{#snippet trigger({ props })}
									<button {...props} type="button" class="text-info hover:underline"
										>{issue.procedure_instance_id ? 'CHANGE' : 'SET'}</button
									>
								{/snippet}
							</EntityPicker>
							{#if issue.procedure_instance_id}<button
									type="button"
									class="text-info hover:underline"
									onclick={() => link('procedure_instance_id', null)}>CLEAR</button
								>{/if}
						</span>
					</div>
				</DetailRow>
				<DetailRow label="Boundary">
					{#if issue.procedure_instance_id && data.steps.length}
						<NativeSelect
							size="sm"
							aria-label="Containment boundary step"
							value={issue.containment_step_id === null ? '' : String(issue.containment_step_id)}
							onchange={setBoundary}
							class="max-w-full"
						>
							<NativeSelectOption value="">—</NativeSelectOption>
							{#each data.steps as s (s.id)}
								<NativeSelectOption value={String(s.id)}
									>{s.label}{s.title ? ` — ${s.title}` : ''}</NativeSelectOption
								>
							{/each}
						</NativeSelect>
					{:else}<span class="text-muted-foreground">—</span>{/if}
				</DetailRow>
				<DetailRow label="Raised at" mono>
					{#if issue.raised_step_label && issue.procedure_instance_id}
						<a
							href={`/executions/${issue.procedure_instance_id}?op=${issue.raised_op_order ?? ''}`}
							class="text-info hover:underline">{issue.raised_step_label}</a
						>
					{:else}<span class="text-muted-foreground">—</span>{/if}
				</DetailRow>
				{#if issue.redline_ops.length}
					<DetailRow label="Redline ops">
						<ul class="grid grid-cols-1 gap-0.5">
							{#each issue.redline_ops as op (op.step_number)}
								<li class="flex gap-2 font-mono text-xs">
									<a
										href={`/executions/${issue.procedure_instance_id}?op=${op.step_number}`}
										class="text-info hover:underline">{op.label}</a
									>
									<span class="truncate font-sans text-sm">{op.title}</span>
									<State value={op.status} class="ml-auto" />
								</li>
							{/each}
						</ul>
					</DetailRow>
				{/if}
			</DetailTable>
		</Section>

		{#if issue.risks.length}
			<Section title="Risks" count={issue.risks.length}>
				{#snippet actions()}
					<Button size="xs" variant="outline" onclick={() => (linkingRisk = !linkingRisk)}
						>+ LINK</Button
					>
				{/snippet}
				<ul class="divide-y divide-border">
					{#each issue.risks as r (r.risk_id + r.relation)}
						<li class="flex items-baseline gap-2 px-3 py-1.5 text-sm">
							<a href={`/risks/${r.risk_id}`} class="font-mono text-info hover:underline"
								>{r.risk_number}</a
							>
							<span class="truncate">{r.title}</span>
							<span class="ml-auto font-mono text-xs tracking-wider text-muted-foreground uppercase"
								>{riskRoleLabel(r.relation)}</span
							>
							{#if r.relation !== 'realized'}
								<button
									type="button"
									class="font-mono text-xs tracking-wider text-info uppercase hover:underline"
									onclick={() => unlinkRisk(r.risk_id, r.risk_number)}>UNLINK</button
								>
							{/if}
						</li>
					{/each}
				</ul>
				{#if linkingRisk}{@render riskPicker()}{/if}
			</Section>
		{:else}
			<div>
				<EmptyLine label="Risks" onadd={() => (linkingRisk = !linkingRisk)} addLabel="+ LINK" />
				{#if linkingRisk}<div class="rounded-b-lg border border-t-0 border-border bg-card">
						{@render riskPicker()}
					</div>{/if}
			</div>
		{/if}
	</div>
</div>

{#snippet riskPicker()}
	<div class="flex items-center gap-2 border-t border-border p-3">
		<NativeSelect size="sm" aria-label="Role" bind:value={riskRole}>
			<NativeSelectOption value="mitigation">MITIGATION</NativeSelectOption>
			<NativeSelectOption value="research">RESEARCH</NativeSelectOption>
		</NativeSelect>
		<div class="min-w-0 flex-1">
			<EntityPicker
				label="Search risks"
				placeholder="Search risks"
				search={searchKind('risk')}
				onpick={(o) => linkRisk(o.value)}
			/>
		</div>
	</div>
{/snippet}

<Dialog.Root open={returning} onOpenChange={(v) => !v && (returning = false)}>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>Return {issue.issue_number} to work</Dialog.Title>
			<Dialog.Description>The comment is recorded in the thread.</Dialog.Description>
		</Dialog.Header>
		<form
			class="grid grid-cols-1 gap-1.5"
			onsubmit={(e) => {
				e.preventDefault();
				submitReturn();
			}}
		>
			<Label for="return-comment">Comment</Label>
			<Textarea id="return-comment" bind:value={returnComment} rows={3} autofocus />
			<Dialog.Footer class="mt-2">
				<Button type="button" variant="outline" onclick={() => (returning = false)}>CANCEL</Button>
				<Button type="submit" disabled={returnBusy || !returnComment.trim()}>RETURN</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root open={noteFor !== null} onOpenChange={(v) => !v && (noteFor = null)}>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>Narrow containment to {stateLabel(noteFor)}</Dialog.Title>
			<Dialog.Description>
				{#if preview.length}
					{issue.issue_number} holds {holdNames(data.holding)}; after this it holds {holdNames(
						preview
					)}. The note is recorded in the thread.
				{:else}
					This releases {holdNames(data.holding) || 'every hold'} held by {issue.issue_number}. The
					note is recorded in the thread.
				{/if}
			</Dialog.Description>
		</Dialog.Header>
		<form
			class="grid grid-cols-1 gap-1.5"
			onsubmit={(e) => {
				e.preventDefault();
				commitNarrowing();
			}}
		>
			<Label for="narrow-note">Note</Label>
			<Textarea id="narrow-note" bind:value={note} rows={3} autofocus />
			<Dialog.Footer class="mt-2">
				<Button type="button" variant="outline" onclick={() => (noteFor = null)}>CANCEL</Button>
				<Button type="submit" disabled={noteBusy || !note.trim()}
					>{preview.length ? 'NARROW' : 'RELEASE HOLD'}</Button
				>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
