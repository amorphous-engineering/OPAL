<script lang="ts">
	import { invalidate } from '$app/navigation';
	import { page } from '$app/state';
	import { api, opal } from '#lib/api.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { MarkdownField } from '#lib/components/markdown/index.js';
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
		toastError,
		type Column,
		type MoreItem,
		Avatar
	} from '#lib/components/opal/index.js';
	import PartPicker from '#lib/components/parts/PartPicker.svelte';
	import InlineText from '#lib/components/issues/InlineText.svelte';
	import IssueRisks from '#lib/components/risks/IssueRisks.svelte'; // added by risks
	import {
		CONTAINMENT_OPTION,
		kb,
		ticketLabel,
		ticketTone
	} from '#lib/components/issues/issues.js';
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
		type IssueType,
		takesDisposition
	} from '@opal/shared';
	import { session } from '#lib/session.svelte.js';
	import ProjectRow from '#lib/components/projects/ProjectRow.svelte'; // added by projects
	import { markdown } from '#lib/markdown.js';
	import { stateLabel } from '#lib/format.js';
	import PluginPanels from '#lib/components/plugins/PluginPanels.svelte';
	import ExternalLinks from '#lib/components/plugins/ExternalLinks.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const issue = $derived(data.issue);
	const bearing = $derived(issue.containment !== 'advisory');
	/** Settled by a signed disposition: it holds work, or it is a non-conformance. */
	const disposable = $derived(takesDisposition(issue));
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

	// ---- Mode: pages open for reading; EDIT reveals what is still pencil ----
	const needsCorrective = $derived(
		issue.issueType === 'non_conformance' && !issue.correctiveAction?.trim()
	);
	const ticket = $derived(issue.ticketState);
	const pending = $derived(ticket === 'pending');
	const inWork = $derived(ticket === 'in_work');
	/** Pencil exists only before review: the observation while pending, the resolution in work. */
	const editable = $derived(!voided && (pending || inWork));
	const editing = $derived(editable && isEditing(page.url));
	const editObservation = $derived(editing && pending);
	const editResolution = $derived(editing && inWork);
	// Work starts at the signed disposition for an issue that takes one. One started before
	// non-conformances took a disposition keeps its start stamp.
	const startedAt = $derived(
		disposable ? (issue.dispositionedAt ?? issue.workStartedAt) : issue.workStartedAt
	);
	const startedBy = $derived(
		disposable && issue.dispositionedAt ? issue.dispositionedBy?.name : issue.workStartedBy?.name
	);
	/** Waiting on a disposition before the issue can go further. */
	const awaitingDisposition = $derived(
		disposable && !voided && !closed && !issue.dispositioned && (pending || inWork)
	);
	const holdsWork = $derived(issue.dispState === 'undispositioned');
	const holdNames = (h: { label: string }[]) => h.map((x) => x.label).join(', ');

	const transition = (step: 'start' | 'review' | 'signOff') =>
		act(async () => {
			await opal.issues[step]({ id: issue.id });
			await refresh();
		});

	async function returnToWork() {
		const comment = await askReason({
			title: `Return ${issue.issueNumber} to work`,
			action: 'RETURN'
		});
		if (comment === null) return;
		await act(async () => {
			await opal.issues.returnFromReview({ id: issue.id, comment });
			await refresh();
		});
	}

	async function reopen() {
		const reason = await askReason({
			title: `Reopen ${issue.issueNumber}`,
			body: `The sign-off by ${issue.closedBy?.name ?? 'the signer'} is withdrawn. The issue returns to work and needs sign-off again.`,
			action: 'REOPEN'
		});
		if (reason === null) return;
		await act(async () => {
			await opal.issues.reopen({ id: issue.id, reason });
			await refresh();
		});
	}

	// Void takes the disposition gate when the issue holds work.
	const canVoid = $derived(
		issue.status === 'open' &&
			!issue.dispositioned &&
			ticket !== 'in_review' &&
			(!holdsWork || issue.canDisposition)
	);
	async function voidIssue() {
		const reason = await askReason({
			title: `Void ${issue.issueNumber}`,
			body: holdsWork
				? `Releases ${holdNames(data.holding) || 'every hold'} held by ${issue.issueNumber}. The issue stays on record as void.`
				: 'The issue stays on record as void and cannot be edited.',
			action: 'VOID',
			destructive: true
		});
		if (reason === null) return;
		await act(async () => {
			await opal.issues.void({ id: issue.id, reason });
			await refresh();
		});
	}

	// ---- Containment ----
	/** Edit mode only widens. Narrowing a hold releases it: it sits under MORE with a note. */
	const widerOptions = $derived(
		CONTAINMENTS.filter((c) => CONTAINMENT_RANK[c] >= CONTAINMENT_RANK[issue.containment])
	);
	const narrowerOptions = $derived(
		CONTAINMENTS.filter((c) => CONTAINMENT_RANK[c] < CONTAINMENT_RANK[issue.containment])
	);

	async function widenContainment(e: Event & { currentTarget: HTMLSelectElement }) {
		const select = e.currentTarget;
		const next = select.value as Containment;
		if (next === issue.containment) return;
		let note: string | undefined;
		if (boundaryHolds) {
			const asked = await askReason({
				title: `Widen containment to ${CONTAINMENT_OPTION[next]}`,
				body: `${issue.issueNumber} stops holding ${holdNames(data.holding) || 'the step'} if that step is unfinished. It then holds at the wider scope.`,
				action: 'WIDEN'
			});
			if (asked === null) {
				select.value = issue.containment;
				return;
			}
			note = asked;
		}
		try {
			await opal.issues.setContainment({ id: issue.id, containment: next, note });
			await refresh();
		} catch (err) {
			toastError(err);
			e.currentTarget.value = issue.containment;
		}
	}

	async function narrowTo(next: Containment) {
		let after: { label: string }[];
		try {
			after = await opal.issues.holding({ id: issue.id, containment: next });
		} catch (err) {
			toastError(err);
			return;
		}
		const note = await askReason({
			title: `Narrow containment to ${CONTAINMENT_OPTION[next]}`,
			body: after.length
				? `${issue.issueNumber} holds ${holdNames(data.holding)}. After this it holds ${holdNames(after)}.`
				: `Releases ${holdNames(data.holding) || 'every hold'} held by ${issue.issueNumber}.`,
			action: 'NARROW'
		});
		if (note === null) return;
		await act(async () => {
			await opal.issues.setContainment({ id: issue.id, containment: next, note });
			await refresh();
		});
	}

	/** A hold anchored on a step: moving its boundary can release that step. */
	const boundaryHolds = $derived(
		holdsWork &&
			issue.containment !== 'wo' &&
			(issue.containmentStepId !== null || issue.raisedStepId !== null)
	);
	/** A wider scope stops holding the step itself, so on a hold anchored to a step it takes the gate. */
	const canWiden = $derived(!boundaryHolds || issue.canDisposition);

	async function setBoundary(e: Event & { currentTarget: HTMLSelectElement }) {
		const select = e.currentTarget;
		const v = select.value;
		let note: string | undefined;
		if (boundaryHolds) {
			const asked = await askReason({
				title: 'Move containment boundary',
				body: `Releases ${holdNames(data.holding) || 'the hold'} if that step is unfinished. ${issue.issueNumber} then holds the new boundary.`,
				action: 'MOVE'
			});
			if (asked === null) {
				select.value = issue.containmentStepId === null ? '' : String(issue.containmentStepId);
				return;
			}
			note = asked;
		}
		await act(async () => {
			await opal.issues.setContainment({
				id: issue.id,
				containment: issue.containment,
				containmentStepId: v ? Number(v) : null,
				note
			});
			await refresh();
		});
	}

	const moreItems = $derived<MoreItem[]>([
		...narrowerOptions.map((c) => ({
			label: `NARROW TO ${CONTAINMENT_OPTION[c]}`,
			onselect: () => narrowTo(c),
			when: holdsWork && issue.canDisposition
		})),
		{ label: 'REOPEN', onselect: reopen, when: ticket === 'done' && issue.canApprove },
		{ label: 'VOID', onselect: voidIssue, strike: true, when: canVoid }
	]);

	/** The reason a void issue carries: the comment `issues.void` wrote. */
	const voidNote = $derived(
		voided ? data.comments.findLast((c) => c.body.startsWith('Voided: ')) : undefined
	);

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
			// `other` is only ever a signed 1.x disposition, and a signed one is not in this form.
			dispType = issue.dispositionType === 'other' ? '' : (issue.dispositionType ?? '');
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

	/** Rework with no redline asks once, inline, before the usual confirmation is skipped. */
	let askNoRedline = $state(false);
	async function sign() {
		if (!dispType || !dispRationale.trim()) return;
		if (reworks(dispType) && redlineHref && !issue.redlineOps.length && !askNoRedline) {
			askNoRedline = true;
			return;
		}
		dispBusy = true;
		try {
			if (!askNoRedline) {
				const holds = await opal.issues.holding({ id: issue.id });
				const drafts = issue.redlineOps.filter((r) => !r.released).map((r) => r.label);
				const ok = await confirm({
					title: `Sign disposition of ${issue.issueNumber}`,
					body: `${stateLabel(dispType)} signed by ${session.user?.name ?? 'you'}. ${
						holds.length ? `Releases ${holds.map((h) => h.label).join(', ')}.` : 'Nothing is held.'
					}${drafts.length ? ` Releases redline ${drafts.join(', ')} to the floor.` : ''} A signed disposition cannot be edited.`,
					action: 'SIGN'
				});
				if (!ok) return;
			}
			await opal.issues.signDisposition({
				id: issue.id,
				dispositionType: dispType,
				dispositionRationale: dispRationale.trim()
			});
			askNoRedline = false;
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

	/** A signature covers the files it could see. Later files are pencil like the resolution. */
	const canRemoveAttachment = (a: Attachment) =>
		editing && (issue.dispositionedAt === null || a.createdAt > issue.dispositionedAt);

	const attachmentColumns = $derived<Column<Attachment>[]>([
		{ key: 'file', label: 'File' },
		{ key: 'type', label: 'Type', width: '9rem' },
		{ key: 'size', label: 'Size', width: '6rem', align: 'right', mono: true },
		{ key: 'by', label: 'Added by', width: '9rem' },
		{ key: 'at', label: 'Added', width: '9rem' },
		...(editing ? [{ key: 'actions', label: '', width: '5rem', align: 'right' as const }] : [])
	]);

	const partLinks = $derived(issue.links.filter((l) => l.kind === 'part')); // added by risks
	const typeFields = $derived({
		nc: type === 'non_conformance',
		anomaly: type === 'anomaly',
		improvement: type === 'improvement'
	});
	const redlineHref = $derived(
		issue.executionId && issue.raisedOpOrder !== null
			? `/executions/${issue.executionId}?op=${issue.raisedOpOrder}&redline_issue=${issue.id}`
			: null
	);
	/** Rework and repair are written as redlines on the work order. */
	const reworks = (t: string | null | undefined) => t === 'rework' || t === 'repair';
	const showCorrection = $derived(
		!!redlineHref &&
			(issue.redlineOps.length > 0 ||
				reworks(
					issue.dispositioned ? issue.dispositionType : editing ? dispType : issue.dispositionType
				))
	);
	const canWriteRedline = $derived(!!redlineHref && issue.status === 'open');
	/** Redlines still a draft or not finished: review waits on them. */
	const openRedlines = $derived(
		issue.redlineOps.filter((r) => !r.released || !['completed', 'skipped'].includes(r.status))
	);
	const waitingRevision = $derived(
		issue.correctiveRevision !== null && !issue.correctiveRevision.released
	);

	// ---- Corrective revision ----
	let procedures = $state<{ id: number; templateNumber: string; name: string }[]>([]);
	$effect(() => {
		if (!editResolution || procedures.length) return;
		opal.procedures
			.list({ projectId: issue.projectId, limit: 100, sort: 'updatedAt', dir: 'desc' })
			.then((r) => {
				const own = issue.execution?.procedureId;
				procedures = r.items
					.filter((x) => x.status !== 'obsolete')
					.sort((a, b) => Number(b.id === own) - Number(a.id === own));
			})
			.catch(() => {});
	});

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
		<span class="inline-flex flex-wrap gap-x-3"
			><span>{by ?? '—'}</span><Timestamp value={at} /></span
		>
	{:else}
		<span class="text-quiet">—</span>
	{/if}
{/snippet}

{#snippet correction()}
	<!-- The rework itself: the redlines written for this issue on its work order. -->
	<DetailRow label="Correction">
		{#if issue.redlineOps.length}
			<ul class="grid grid-cols-1 gap-1">
				{#each issue.redlineOps as r (r.stepNumber)}
					{@const done = r.status === 'completed' || r.status === 'skipped'}
					<li class="flex flex-wrap items-baseline gap-x-3">
						<a
							href={`/executions/${issue.executionId}?op=${r.stepNumber}`}
							class="font-mono text-info hover:underline">OP {r.label}</a
						>
						<span>{r.title}</span>
						<State
							value={!r.released ? 'draft' : done ? 'done' : 'released'}
							tone={!r.released ? 'draft' : done ? 'ok' : 'default'}
							label={!r.released ? 'DRAFT' : done ? 'DONE' : 'RELEASED'}
						/>
						{#if r.doneAt}
							<span class="basis-full text-xs text-muted-foreground"
								>{@render stamp(r.doneBy, r.doneAt)}</span
							>
						{/if}
					</li>
				{/each}
			</ul>
		{:else}
			<span class="block h-7 border border-dashed border-foreground"></span>
		{/if}
		{#if canWriteRedline && redlineHref && editing}
			<div class="mt-1.5">
				<Button
					size="sm"
					variant={issue.redlineOps.length ? 'outline' : 'default'}
					href={redlineHref}>{issue.redlineOps.length ? '+ REDLINE' : 'WRITE REDLINE'}</Button
				>
			</div>
		{/if}
	</DetailRow>
{/snippet}

{#snippet textRow(
	label: string,
	field: TextField,
	opts?: { rich?: boolean; hint?: string; resolution?: boolean }
)}
	<DetailRow {label}>
		<InlineText
			{label}
			value={issue[field]}
			multiline
			rich={opts?.rich ?? true}
			hint={opts?.hint}
			readonly={!(opts?.resolution ? editResolution : editObservation)}
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
		<h1
			class={[
				'min-w-0 text-lg font-semibold tracking-tight [&>div]:items-center',
				voided && 'text-muted-foreground line-through'
			]}
		>
			{#if editObservation}
				<InlineText label="Title" value={issue.title} required onsave={text('title')} />
			{:else}
				{issue.title}
			{/if}
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
		{#if !voided}
			{#if pending && disposable}
				<!-- The disposition is filled in and signed under EDIT, so EDIT is the move. -->
				<EditToggle variant={editing ? 'outline' : 'default'} />
			{:else if pending}
				<Button size="sm" onclick={() => transition('start')}>START WORK</Button>
			{:else if inWork}
				<Button
					size="sm"
					disabled={awaitingDisposition || openRedlines.length > 0}
					title={awaitingDisposition
						? 'A signed disposition is required'
						: openRedlines.length
							? `Waits on redline ${openRedlines.map((r) => r.label).join(', ')}`
							: undefined}
					onclick={() => transition('review')}>SUBMIT FOR REVIEW</Button
				>
				{#if awaitingDisposition}
					<span class="font-mono text-xs text-muted-foreground">Disposition is required</span>
				{/if}
			{:else if ticket === 'in_review'}
				<Button
					size="sm"
					disabled={needsCorrective || cannotApprove || waitingRevision}
					title={cannotApprove
						? issue.gateReasons.approve
						: needsCorrective
							? 'Corrective action is required to sign off'
							: waitingRevision
								? `Waits on the release of ${issue.correctiveRevision?.templateNumber} v${issue.correctiveRevision?.versionNumber}`
								: undefined}
					onclick={() => transition('signOff')}>SIGN OFF</Button
				>
				{#if cannotApprove}
					<span class="font-mono text-xs text-muted-foreground" data-gate-reason="approve"
						>{issue.gateReasons.approve ?? 'Requires approval role'}</span
					>
				{/if}
				<Button size="sm" variant="outline" onclick={returnToWork}>RETURN</Button>
			{/if}
			{#if editable && !(pending && disposable)}<EditToggle />{/if}
			<MoreMenu items={moreItems} />
		{/if}
	{/snippet}
</PageHeader>

{#if voided}
	<div class="border-b border-border bg-muted/40 px-4 py-2 text-sm" data-void-reason>
		<span class="label mr-2">Voided</span>
		{#if voidNote}
			{voidNote.body.slice('Voided: '.length)}
			<span class="ml-2 text-xs text-muted-foreground">
				{voidNote.user?.name ?? '—'} · <Timestamp value={voidNote.createdAt} />
			</span>
		{/if}
	</div>
{/if}

<div class="grid grid-cols-1 gap-4 p-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
	<div class="grid grid-cols-1 content-start gap-4">
		<Section title="Details">
			<DetailTable>
				{@render textRow('Description', 'description')}
				{#if typeFields.nc || issue.shouldBe || issue.actual}
					{@render textRow('Should be', 'shouldBe')}
					{@render textRow('Is', 'actual')}
				{/if}
				{#if typeFields.anomaly || issue.stepsToReproduce || issue.expectedBehavior || issue.actualBehavior}
					{@render textRow('Steps to reproduce', 'stepsToReproduce')}
					{@render textRow('Expected behavior', 'expectedBehavior')}
					{@render textRow('Observed behavior', 'actualBehavior')}
				{/if}
				{#if typeFields.improvement || issue.expectedBenefit}
					{@render textRow('Expected benefit', 'expectedBenefit')}
				{/if}
				{#if typeFields.nc || typeFields.anomaly || issue.rootCause || issue.correctiveAction}
					{@render textRow('Root cause', 'rootCause', { resolution: true })}
					{@render textRow('Corrective action', 'correctiveAction', {
						resolution: true,
						hint: needsCorrective && !closed && !voided ? 'Required to sign off' : undefined
					})}
				{/if}
				{#if issue.correctiveRevision || (editResolution && typeFields.nc)}
					<DetailRow label="Revision">
						{#if issue.correctiveRevision}
							{@const rev = issue.correctiveRevision}
							<div class="flex flex-wrap items-baseline gap-x-3">
								<a
									href={`/procedures/${rev.procedureId}`}
									class="font-mono text-info hover:underline"
									>{rev.templateNumber} v{rev.versionNumber}</a
								>
								<span>{rev.name}</span>
								<State
									value={rev.released ? 'released' : 'draft'}
									tone={rev.released ? 'ok' : 'draft'}
									label={rev.released ? 'RELEASED' : 'DRAFT'}
								/>
								{#if editResolution}
									<button
										type="button"
										class="ml-auto font-mono text-xs tracking-wider text-info uppercase hover:underline"
										onclick={() => act(() => patch({ correctiveProcedureId: null }))}>REMOVE</button
									>
								{/if}
							</div>
						{:else}
							<NativeSelect
								aria-label="Procedure revision"
								value=""
								onchange={(e) =>
									e.currentTarget.value &&
									act(() => patch({ correctiveProcedureId: Number(e.currentTarget.value) }))}
								class="max-w-full"
							>
								<NativeSelectOption value="">—</NativeSelectOption>
								{#each procedures as p (p.id)}
									<NativeSelectOption value={String(p.id)}
										>{p.templateNumber} {p.name}</NativeSelectOption
									>
								{/each}
							</NativeSelect>
						{/if}
					</DetailRow>
				{/if}
			</DetailTable>
		</Section>

		{#if issue.dispositioned || (disposable && !closed && !voided)}
			<Section id="disposition" title="Disposition">
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
						{#if showCorrection}{@render correction()}{/if}
						<DetailRow label="Signed by">
							{@render stamp(issue.dispositionedBy?.name ?? null, issue.dispositionedAt)}
						</DetailRow>
					{:else if editing}
						<DetailRow label="Type">
							<NativeSelect
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
						{#if showCorrection}{@render correction()}{/if}
						<DetailRow label="Signature">
							{#if askNoRedline}
								<div class="grid grid-cols-1 gap-2 border border-border p-2">
									<span class="text-sm text-error"
										>Signing without a redline releases the hold{data.holding.length
											? ` on ${holdNames(data.holding)}`
											: ''} immediately and implies no rework is necessary for this WO. Are you sure?</span
									>
									<div class="flex flex-wrap gap-2">
										<Button size="sm" variant="outline" disabled={dispBusy} onclick={sign}
											>SIGN WITHOUT REDLINE</Button
										>
										<Button size="sm" variant="ghost" onclick={() => (askNoRedline = false)}
											>CANCEL</Button
										>
									</div>
								</div>
							{:else}
								<Button
									size="sm"
									variant={showCorrection && !issue.redlineOps.length ? 'outline' : 'default'}
									disabled={dispBusy || cannotDisposition || !dispType || !dispRationale.trim()}
									title={cannotDisposition
										? issue.gateReasons.disposition
										: !dispType || !dispRationale.trim()
											? `missing: ${[!dispType && 'type', !dispRationale.trim() && 'rationale'].filter(Boolean).join(', ')}`
											: undefined}
									onclick={sign}>SIGN DISPOSITION</Button
								>
							{/if}
							{#if cannotDisposition}
								<span
									class="ml-2 font-mono text-xs text-muted-foreground"
									data-gate-reason="disposition"
									>{issue.gateReasons.disposition ?? 'Requires disposition role'}</span
								>
							{/if}
						</DetailRow>
					{:else}
						<DetailRow
							label="Type"
							mono
							value={issue.dispositionType ? stateLabel(issue.dispositionType) : null}
						/>
						<DetailRow label="Rationale">
							{#if issue.dispositionRationale}
								<!-- eslint-disable-next-line svelte/no-at-html-tags -->
								<div class="prose-opal">{@html markdown(issue.dispositionRationale)}</div>
							{:else}<span class="text-quiet">—</span>{/if}
						</DetailRow>
						{#if showCorrection}{@render correction()}{/if}
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
								{#if c.user}<Avatar user={c.user} size="xs" />{/if}
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
				<Label for="comment" class="sr-only">Comment</Label>
				<MarkdownField
					id="comment"
					bind:value={comment}
					minRows={1}
					placeholder="Add a comment"
					onsubmit={postComment}
				/>
				{#if comment.trim()}
					<div>
						<Button type="submit" size="sm" disabled={commentBusy}>POST</Button>
					</div>
				{/if}
			</form>
		</Section>

		{#snippet addFiles()}
			{#if !voided}
				<Button size="sm" variant="outline" disabled={uploading} onclick={() => fileInput?.click()}>
					+ ADD FILE
				</Button>
				<Button
					size="sm"
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
						{:else if canRemoveAttachment(a)}
							<ActionLink onclick={() => removeAttachment(a)}>DELETE</ActionLink>
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
			{#snippet actions()}
				<ActionLink href={`/audit?entity=issue&record=${issue.id}`}>AUDIT</ActionLink>
			{/snippet}
			<DetailTable>
				<ProjectRow id={issue.projectId} code={issue.projectCode} name={issue.projectName} />
				<!-- added by projects -->
				<DetailRow label="Type">
					{#if editObservation}
						<NativeSelect
							aria-label="Type"
							value={issue.issueType}
							onchange={(e) => act(() => patch({ issueType: e.currentTarget.value as IssueType }))}
						>
							{#each ISSUE_TYPES as t (t)}<NativeSelectOption value={t}
									>{stateLabel(t)}</NativeSelectOption
								>{/each}
						</NativeSelect>
					{:else}{stateLabel(issue.issueType)}{/if}
				</DetailRow>
				<DetailRow label="Priority">
					{#if editing}
						<NativeSelect
							aria-label="Priority"
							value={issue.priority}
							onchange={(e) =>
								act(() => patch({ priority: e.currentTarget.value as IssuePriority }))}
						>
							{#each ISSUE_PRIORITIES as p (p)}<NativeSelectOption value={p}
									>{stateLabel(p)}</NativeSelectOption
								>{/each}
						</NativeSelect>
					{:else}{stateLabel(issue.priority)}{/if}
				</DetailRow>
				<DetailRow label="Containment">
					{#if editObservation && canWiden}
						<NativeSelect
							aria-label="Containment"
							value={issue.containment}
							onchange={widenContainment}
						>
							{#each widerOptions as c (c)}<NativeSelectOption value={c}
									>{CONTAINMENT_OPTION[c]}</NativeSelectOption
								>{/each}
						</NativeSelect>
					{:else}<span class="font-mono"
							>{CONTAINMENT_OPTION[issue.containment]}{issue.containment === 'step' &&
							(issue.containmentStepLabel ?? issue.raisedStepLabel)
								? ` ${issue.containmentStepLabel ?? issue.raisedStepLabel}`
								: ''}</span
						>{/if}
				</DetailRow>
				<DetailRow label="Assigned to">
					{#if editing}
						<NativeSelect
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
					{:else if issue.assignedTo}{issue.assignedTo.name}{:else}<span
							class="text-muted-foreground">Unassigned</span
						>{/if}
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
				{#if editing}
					<PartPicker align="end" onselect={(p) => p && addPart(p.id)}>
						{#snippet trigger({ props })}
							<Button {...props} size="sm" variant="outline">+ PART</Button>
						{/snippet}
					</PartPicker>
				{/if}
			{/snippet}
			<DetailTable>
				<DetailRow label="Parts">
					{#if partLinks.length}
						<ul class="grid grid-cols-1 gap-0.5">
							{#each partLinks as l (l.id)}
								<li class="flex min-w-0 items-baseline gap-2">
									<a href={l.href} class="font-mono whitespace-nowrap text-info hover:underline"
										>{l.label}</a
									>
									<span class="min-w-0 truncate text-muted-foreground">{l.sublabel}</span>
									{#if editObservation}
										<button
											type="button"
											class="ml-auto font-mono text-xs tracking-wider text-info uppercase hover:underline"
											onclick={() => removeLink(l.id)}>REMOVE</button
										>
									{/if}
								</li>
							{/each}
						</ul>
					{:else}<span class="text-quiet">—</span>{/if}
				</DetailRow>
				<DetailRow label="Procedure">
					{#if issue.execution?.procedureId}
						<a href={`/procedures/${issue.execution.procedureId}`} class="text-info hover:underline"
							>{issue.execution.procedureName}</a
						>
					{:else}<span class="text-quiet">—</span>{/if}
				</DetailRow>
				<DetailRow label="Work order">
					<div class="flex min-w-0 flex-wrap items-baseline gap-x-2">
						{#if issue.execution}
							<a
								href={`/executions/${issue.execution.id}${issue.raisedOpOrder !== null ? `?op=${issue.raisedOpOrder}` : ''}`}
								class="font-mono text-info hover:underline"
								>{issue.execution.label ?? 'Work order'}{issue.raisedStepLabel
									? ` OP ${issue.raisedStepLabel}`
									: ''}</a
							>
							{#if editObservation}
								<button
									type="button"
									class="ml-auto font-mono text-xs tracking-wider text-info uppercase hover:underline"
									onclick={() => act(() => patch({ executionId: null }))}>CLEAR</button
								>
							{/if}
						{:else}<span class="text-quiet">—</span>{/if}
					</div>
				</DetailRow>
				{#if editObservation && issue.execution && data.steps.length && (!boundaryHolds || issue.canDisposition)}
					<DetailRow label="Boundary">
						<NativeSelect
							aria-label="Containment boundary step"
							value={issue.containmentStepId === null ? '' : String(issue.containmentStepId)}
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
					</DetailRow>
				{/if}
			</DetailTable>
		</Section>

		<!-- added by risks -->
		<IssueRisks {issue} {refresh} readonly={!editObservation} />

		<PluginPanels slot="issue.side" recordId={issue.id} number={issue.issueNumber} />
		<ExternalLinks entityType="issue" entityId={issue.id} />
	</div>
</div>
