<script lang="ts">
	import { invalidate } from '$app/navigation';
	import { api, opal } from '#lib/api.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { MarkdownField } from '#lib/components/markdown/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
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
		type Column,
		Avatar
	} from '#lib/components/opal/index.js';
	import PartPicker from '#lib/components/parts/PartPicker.svelte';
	import InlineText from '#lib/components/issues/InlineText.svelte';
	import { CONTAINMENT_OPTION, kb, ticketLabel, ticketTone } from '#lib/components/issues/issues.js';
	import {
		CONTAINMENTS,
		CONTAINMENT_RANK,
		DISPOSITION_TYPES,
		ISSUE_PRIORITIES,
		ISSUE_TYPES,
		type Containment,
		type Attachment,
		type DispositionType,
		type IssuePriority,
		type IssueType
	} from '@opal/shared';
	import { session } from '#lib/session.svelte.js';
	import { markdown } from '#lib/markdown.js';
	import { stateLabel } from '#lib/format.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const issue = $derived(data.issue);
	const bearing = $derived(issue.containment !== 'advisory');
	const closed = $derived(issue.status === 'closed');
	const voided = $derived(issue.status === 'void');
	const type = $derived(issue.issueType);

	const refresh = () => invalidate('issue:detail');

	type Patch = Omit<Parameters<typeof opal.issues.update>[0], 'id'>;

	/** Edit one or more fields; reload the page data. */
	async function patch(fields: Patch) {
		await opal.issues.update({ id: issue.id, ...fields });
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
		issue.issueType === 'non_conformance' && !issue.correctiveAction?.trim()
	);
	const ticket = $derived(issue.ticketState);
	// Work starts at the signed disposition for containment-bearing issues.
	const startedAt = $derived(bearing ? issue.dispositionedAt : issue.workStartedAt);
	const startedBy = $derived(bearing ? issue.dispositionedBy?.name : issue.workStartedBy?.name);

	const transition = (step: 'start' | 'review' | 'signOff') =>
		act(async () => {
			await opal.issues[step]({ id: issue.id });
			await refresh();
		});

	let returning = $state(false);
	let returnComment = $state('');
	let returnBusy = $state(false);
	async function submitReturn() {
		if (!returnComment.trim()) return;
		returnBusy = true;
		try {
			await opal.issues.returnFromReview({ id: issue.id, comment: returnComment.trim() });
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
	let voiding = $state(false);
	let voidReason = $state('');
	let voidBusy = $state(false);
	async function submitVoid() {
		if (!voidReason.trim()) return;
		voidBusy = true;
		try {
			await opal.issues.void({ id: issue.id, reason: voidReason.trim() });
			toast.success(`${issue.issueNumber} voided`);
			voiding = false;
			voidReason = '';
			await refresh();
		} catch (e) {
			toastError(e);
		} finally {
			voidBusy = false;
		}
	}

	// ---- Containment ----
	let noteFor = $state<Containment | null>(null);
	let note = $state('');
	let noteBusy = $state(false);
	// Holds after the proposed narrowing, from the same readout the Holds section uses.
	let preview = $state<{ label: string; href: string }[]>([]);
	const holdNames = (h: { label: string }[]) => h.map((x) => x.label).join(' · ');

	async function setContainment(e: Event & { currentTarget: HTMLSelectElement }) {
		const next = e.currentTarget.value as Containment;
		const select = e.currentTarget;
		if (next === issue.containment) return;
		const narrowing = CONTAINMENT_RANK[next] < CONTAINMENT_RANK[issue.containment];
		if (narrowing && issue.dispState === 'undispositioned') {
			select.value = issue.containment;
			note = '';
			preview = [];
			noteFor = next;
			try {
				preview = await opal.issues.holding({ id: issue.id, containment: next });
			} catch (err) {
				toastError(err);
			}
			return;
		}
		try {
			await opal.issues.setContainment({ id: issue.id, containment: next });
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
			await opal.issues.setContainment({
				id: issue.id,
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
			await opal.issues.setContainment({
				id: issue.id,
				containment: issue.containment,
				containmentStepId: v ? Number(v) : null
			});
			await refresh();
		});
	}

	// ---- Disposition ----
	let dispType = $state<DispositionType | ''>('');
	let dispRationale = $state('');
	let dispBusy = $state(false);
	// Seed the draft from the server and re-seed when the issue changes.
	let seededFor = $state<string>('');
	$effect(() => {
		const key = `${issue.id}:${issue.updatedAt}`;
		if (key !== seededFor) {
			seededFor = key;
			dispType = issue.dispositionType ?? '';
			dispRationale = issue.dispositionRationale ?? '';
		}
	});

	async function saveDraft() {
		if (issue.dispositioned || voided) return;
		const changes: Patch = {};
		if (dispType !== (issue.dispositionType ?? '')) changes.dispositionType = dispType || null;
		if (dispRationale !== (issue.dispositionRationale ?? ''))
			changes.dispositionRationale = dispRationale;
		if (!Object.keys(changes).length) return;
		await act(() => patch(changes));
	}

	async function sign() {
		if (!dispType || !dispRationale.trim()) return;
		dispBusy = true;
		try {
			const holds = await opal.issues.holding({ id: issue.id });
			const ok = await confirm({
				title: `Sign disposition of ${issue.issueNumber}`,
				body: `${stateLabel(dispType)} signed by ${session.user?.name ?? 'you'}. ${
					holds.length ? `Releases ${holds.map((h) => h.label).join(' · ')}.` : 'Nothing is held.'
				} A signed disposition cannot be edited.`,
				action: 'SIGN'
			});
			if (!ok) return;
			await opal.issues.signDisposition({
				id: issue.id,
				dispositionType: dispType,
				dispositionRationale: dispRationale.trim()
			});
			await refresh();
		} catch (e) {
			toastError(e);
		} finally {
			dispBusy = false;
		}
	}

	// ---- Links ----
	async function addPart(partId: number) {
		await act(async () => {
			await opal.issues.addLink({ id: issue.id, kind: 'part', targetId: partId });
			await refresh();
		});
	}
	async function removeLink(linkId: number) {
		await act(async () => {
			await opal.issues.removeLink({ id: issue.id, linkId });
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
			await opal.issues.addComment({ id: issue.id, body: comment.trim() });
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
			fd.append('ownerType', 'issue');
			fd.append('ownerId', String(issue.id));
			try {
				await api.post('/attachments', fd);
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
			title: `Delete ${a.filename}`,
			body: 'The file is removed from the issue.',
			action: 'DELETE',
			destructive: true
		});
		if (!ok) return;
		await act(async () => {
			await opal.platform.attachments.delete({ id: a.id });
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
		issue.executionId && issue.raisedOpOrder !== null
			? `/executions/${issue.executionId}?op=${issue.raisedOpOrder}&redline_issue=${issue.id}`
			: null
	);
	const hasRedlineAction = $derived(
		issue.dispositioned &&
			['rework', 'repair'].includes(issue.dispositionType ?? '') &&
			!!redlineHref
	);

	// Gate flags come from the server per viewer.
	const cannotApprove = $derived(!issue.canApprove);
	const cannotDisposition = $derived(!issue.canDisposition);

	type TextField =
		| 'title'
		| 'description'
		| 'shouldBe'
		| 'actual'
		| 'stepsToReproduce'
		| 'expectedBehavior'
		| 'actualBehavior'
		| 'expectedBenefit'
		| 'rootCause'
		| 'correctiveAction';
	function text(field: TextField) {
		return async (v: string | null) => patch({ [field]: v });
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
	field: TextField,
	opts?: { required?: boolean; rich?: boolean; hint?: string }
)}
	<DetailRow {label}>
		<InlineText
			{label}
			value={issue[field]}
			multiline
			rich={opts?.rich ?? true}
			hint={opts?.hint}
			onsave={text(field)}
		/>
	</DetailRow>
{/snippet}

<PageHeader
	title={issue.title}
	identifier={issue.issueNumber}
	crumbs={[{ label: 'Issues', href: '/issues' }, { label: issue.issueNumber }]}
>
	{#snippet heading()}
		<h1 class="min-w-0 text-lg font-semibold tracking-tight [&>div]:items-center">
			<InlineText label="Title" value={issue.title} required onsave={text('title')} />
		</h1>
	{/snippet}
	{#snippet state()}
		{#if voided}
			<State value="void" label="VOID" tone="muted" badge />
		{:else}
			<State value={ticket} label={ticketLabel(ticket)} tone={ticketTone(ticket)} badge />
		{/if}
	{/snippet}
	{#snippet actions()}
		<Button size="sm" variant="ghost" href={`/audit?entity=issue&record=${issue.id}`}>AUDIT</Button>
		{#if voided}
			<!-- a void issue is terminal -->
		{:else if ticket === 'done'}
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
					? issue.gateReasons.approve
					: needsCorrective
						? 'Corrective action is required to sign off'
						: undefined}
				onclick={() => transition('signOff')}>SIGN OFF</Button
			>
			{#if cannotApprove}
				<span class="font-mono text-xs text-muted-foreground" data-gate-reason="approve"
					>{issue.gateReasons.approve ?? 'Requires approval role'}</span
				>
			{/if}
			<Button size="sm" variant="outline" onclick={() => (returning = true)}>RETURN</Button>
		{/if}
		{#if !voided}
			<Button size="sm" variant="destructive" onclick={() => (voiding = true)}>VOID</Button>
		{/if}
	{/snippet}
</PageHeader>

<div class="grid grid-cols-1 gap-4 p-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
	<div class="grid grid-cols-1 content-start gap-4">
		<Section title="Details">
			<DetailTable>
				{@render textRow('Description', 'description')}
				{#if typeFields.nc || issue.shouldBe || issue.actual}
					{@render textRow('Should be', 'shouldBe')}
					{@render textRow('Is', 'actual')}
				{/if}
				{#if typeFields.bug || issue.stepsToReproduce || issue.expectedBehavior || issue.actualBehavior}
					{@render textRow('Steps to reproduce', 'stepsToReproduce')}
					{@render textRow('Expected behavior', 'expectedBehavior')}
					{@render textRow('Actual behavior', 'actualBehavior')}
				{/if}
				{#if typeFields.improvement || issue.expectedBenefit}
					{@render textRow('Expected benefit', 'expectedBenefit')}
				{/if}
				{#if typeFields.nc || typeFields.bug || issue.rootCause || issue.correctiveAction}
					{@render textRow('Root cause', 'rootCause')}
					{@render textRow('Corrective action', 'correctiveAction', {
						hint: typeFields.nc && !closed ? 'required for sign-off' : undefined
					})}
				{/if}
			</DetailTable>
		</Section>

		{#if issue.dispositioned || (bearing && !closed && !voided)}
			<Section title="Disposition">
				{#snippet actions()}
					{#if issue.selfDispositioned}
						<State value="self_dispositioned" tone="warn" badge label="SELF-DISPOSITIONED" />
					{/if}
				{/snippet}
				<DetailTable>
					{#if issue.dispositioned}
						<DetailRow label="Type" mono value={stateLabel(issue.dispositionType)} />
						<DetailRow label="Rationale">
							<!-- eslint-disable-next-line svelte/no-at-html-tags -->
							<div class="prose-opal">{@html markdown(issue.dispositionRationale)}</div>
						</DetailRow>
						<DetailRow label="Signed by">
							{issue.dispositionedBy?.name ?? '—'} ·
							<Timestamp value={issue.dispositionedAt} />
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
								{#each DISPOSITION_TYPES as d (d)}
									<NativeSelectOption value={d}>{stateLabel(d)}</NativeSelectOption>
								{/each}
							</NativeSelect>
						</DetailRow>
						<DetailRow label="Rationale">
							<div
								role="presentation"
								onfocusout={(e) => {
									if (!e.currentTarget.contains(e.relatedTarget as Node | null)) saveDraft();
								}}
							>
								<MarkdownField bind:value={dispRationale} ariaLabel="Rationale" minRows={3} />
							</div>
						</DetailRow>
						<DetailRow label="Signature">
							<Button
								size="sm"
								disabled={dispBusy || cannotDisposition || !dispType || !dispRationale.trim()}
								title={cannotDisposition
									? issue.gateReasons.disposition
									: !dispType || !dispRationale.trim()
										? `missing: ${[!dispType && 'type', !dispRationale.trim() && 'rationale'].filter(Boolean).join(', ')}`
										: undefined}
								onclick={sign}>SIGN DISPOSITION</Button
							>
							{#if cannotDisposition}
								<span
									class="ml-2 font-mono text-xs text-muted-foreground"
									data-gate-reason="disposition"
									>{issue.gateReasons.disposition ?? 'Requires disposition role'}</span
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
								{#if c.user}<Avatar user={{ id: c.user.id, name: c.user.name }} size="xs" />{/if}
								<span class="font-medium">{c.user?.name ?? 'System'}</span>
								<Timestamp value={c.createdAt} />
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
				<MarkdownField id="comment" bind:value={comment} minRows={3} onsubmit={postComment} />
				<div>
					<Button type="submit" size="sm" disabled={commentBusy || !comment.trim()}>POST</Button>
				</div>
			</form>
		</Section>

		{#snippet addFiles()}
			{#if !voided}
				<Button size="xs" variant="outline" disabled={uploading} onclick={() => fileInput?.click()}>
					+ ADD FILE
				</Button>
				<Button
					size="xs"
					variant="outline"
					disabled={uploading}
					onclick={() => cameraInput?.click()}
				>
					CAMERA
				</Button>
			{/if}
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
							<a href={a.href} class="font-mono text-info hover:underline" download>{a.filename}</a>
						{:else if col.key === 'type'}
							<span class="font-mono text-xs text-muted-foreground">{a.mimeType}</span>
						{:else if col.key === 'size'}
							{kb(a.sizeBytes)}
						{:else if col.key === 'by'}
							{a.uploadedByName ?? '—'}
						{:else if col.key === 'at'}
							<Timestamp value={a.createdAt} />
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
						value={issue.issueType}
						onchange={(e) => act(() => patch({ issueType: e.currentTarget.value as IssueType }))}
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
						onchange={(e) => act(() => patch({ priority: e.currentTarget.value as IssuePriority }))}
					>
						{#each ISSUE_PRIORITIES as p (p)}<NativeSelectOption value={p}
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
						disabled={closed || voided}
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
						value={issue.assignedTo === null ? '' : String(issue.assignedTo.id)}
						onchange={(e) =>
							act(() =>
								patch({
									assignedToId: e.currentTarget.value ? Number(e.currentTarget.value) : null
								})
							)}
					>
						<NativeSelectOption value="">Unassigned</NativeSelectOption>
						{#each data.assignees as a (a.id)}
							<NativeSelectOption value={String(a.id)}>{a.name}</NativeSelectOption>
						{/each}
					</NativeSelect>
				</DetailRow>
				<DetailRow label="Raised by" value={issue.raisedBy?.name} />
				<DetailRow label="Created"><Timestamp value={issue.createdAt} /></DetailRow>
				<DetailRow label="Work started">
					{@render stamp(startedBy ?? null, startedAt)}
				</DetailRow>
				<DetailRow label="Review requested">
					{@render stamp(issue.reviewRequestedBy?.name ?? null, issue.reviewRequestedAt)}
				</DetailRow>
				<DetailRow label="Closed">
					{@render stamp(issue.closedBy?.name ?? null, issue.closedAt)}
				</DetailRow>
				<DetailRow label="Updated"><Timestamp value={issue.updatedAt} /></DetailRow>
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
			{#snippet actions()}
				{#if !voided}
					<PartPicker align="end" onselect={(p) => p && addPart(p.id)}>
						{#snippet trigger({ props })}
							<Button {...props} size="xs" variant="outline">+ PART</Button>
						{/snippet}
					</PartPicker>
				{/if}
			{/snippet}
			<DetailTable>
				<DetailRow label="Parts">
					{#if issue.links.length}
						<ul class="grid grid-cols-1 gap-0.5">
							{#each issue.links as l (l.id)}
								<li class="flex min-w-0 items-baseline gap-2">
									<a href={l.href} class="font-mono whitespace-nowrap text-info hover:underline"
										>{l.label}</a
									>
									<span class="min-w-0 truncate text-muted-foreground">{l.sublabel}</span>
									{#if !voided}
										<button
											type="button"
											class="ml-auto font-mono text-xs tracking-wider text-info uppercase hover:underline"
											onclick={() => removeLink(l.id)}>REMOVE</button
										>
									{/if}
								</li>
							{/each}
						</ul>
					{:else}<span class="text-muted-foreground">—</span>{/if}
				</DetailRow>
				<DetailRow label="Procedure">
					{#if issue.execution?.procedureId}
						<a
							href={`/procedures/${issue.execution.procedureId}`}
							class="text-info hover:underline">{issue.execution.procedureName}</a
						>
					{:else}<span class="text-muted-foreground">—</span>{/if}
				</DetailRow>
				<DetailRow label="Execution">
					<div class="flex min-w-0 flex-wrap items-baseline gap-x-2">
						{#if issue.execution}
							<a
								href={`/executions/${issue.execution.id}`}
								class="font-mono text-info hover:underline">{issue.execution.label ?? 'Work order'}</a
							>
							{#if !voided}
								<button
									type="button"
									class="ml-auto font-mono text-xs tracking-wider text-info uppercase hover:underline"
									onclick={() => act(() => patch({ executionId: null }))}>CLEAR</button
								>
							{/if}
						{:else}<span class="text-muted-foreground">—</span>{/if}
					</div>
				</DetailRow>
				<DetailRow label="Boundary">
					{#if issue.execution && data.steps.length}
						<NativeSelect
							size="sm"
							aria-label="Containment boundary step"
							value={issue.containmentStepId === null ? '' : String(issue.containmentStepId)}
							onchange={setBoundary}
							disabled={voided}
							class="max-w-full"
						>
							<NativeSelectOption value="">—</NativeSelectOption>
							{#each data.steps as s (s.id)}
								<NativeSelectOption value={String(s.id)}
									>{s.label}{s.title ? ` — ${s.title}` : ''}</NativeSelectOption
								>
							{/each}
						</NativeSelect>
					{:else if issue.containmentStepLabel}
						<span class="font-mono">{issue.containmentStepLabel}</span>
					{:else}<span class="text-muted-foreground">—</span>{/if}
				</DetailRow>
				<DetailRow label="Raised at" mono>
					{#if issue.raisedStepLabel && issue.execution}
						<a
							href={`/executions/${issue.execution.id}?op=${issue.raisedOpOrder ?? ''}`}
							class="text-info hover:underline">{issue.raisedStepLabel}</a
						>
					{:else}<span class="text-muted-foreground">—</span>{/if}
				</DetailRow>
				{#if issue.redlineOps.length}
					<DetailRow label="Redline ops">
						<ul class="grid grid-cols-1 gap-0.5">
							{#each issue.redlineOps as op (op.stepNumber)}
								<li class="flex gap-2 font-mono text-xs">
									<a
										href={`/executions/${issue.executionId}?op=${op.stepNumber}`}
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
				<ul class="divide-y divide-border">
					{#each issue.risks as r (r.riskId + r.relation)}
						<li class="flex items-baseline gap-2 px-3 py-1.5 text-sm">
							<a href={`/risks/${r.riskId}`} class="font-mono text-info hover:underline"
								>{r.riskNumber}</a
							>
							<span class="truncate">{r.title}</span>
							<span class="ml-auto font-mono text-xs tracking-wider text-muted-foreground uppercase"
								>{riskRoleLabel(r.relation)}</span
							>
						</li>
					{/each}
				</ul>
			</Section>
		{:else}
			<EmptyLine label="Risks" />
		{/if}
	</div>
</div>

<Dialog.Root open={returning} onOpenChange={(v) => !v && (returning = false)}>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>Return {issue.issueNumber} to work</Dialog.Title>
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

<Dialog.Root open={voiding} onOpenChange={(v) => !v && (voiding = false)}>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>Void {issue.issueNumber}</Dialog.Title>
			<Dialog.Description>
				{#if bearing && !issue.dispositioned}
					Voiding releases {holdNames(data.holding) || 'every hold'} held by {issue.issueNumber}. The
					issue stays on record as void.
				{:else}
					The issue stays on record as void and cannot be edited.
				{/if}
			</Dialog.Description>
		</Dialog.Header>
		<form
			class="grid grid-cols-1 gap-1.5"
			onsubmit={(e) => {
				e.preventDefault();
				submitVoid();
			}}
		>
			<Label for="void-reason">Reason</Label>
			<Textarea id="void-reason" bind:value={voidReason} rows={3} autofocus />
			<Dialog.Footer class="mt-2">
				<Button type="button" variant="outline" onclick={() => (voiding = false)}>CANCEL</Button>
				<Button type="submit" variant="destructive" disabled={voidBusy || !voidReason.trim()}
					>VOID</Button
				>
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
					{issue.issueNumber} holds {holdNames(data.holding)}; after this it holds {holdNames(
						preview
					)}. The note is recorded in the thread.
				{:else}
					This releases {holdNames(data.holding) || 'every hold'} held by {issue.issueNumber}. The
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
