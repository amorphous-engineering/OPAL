<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import {
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
		queryHref,
		toast,
		toastError,
		type Column,
		type MoreItem
	} from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import { opal } from '#lib/api.js';
	import References from '#lib/components/risks/References.svelte';
	import { RISK_DISPOSITIONS, type RiskDisposition, type RiskHistoryRow } from '@opal/shared';
	import { markdown } from '#lib/markdown.js';
	import DispositionPanel from '#lib/components/risks/DispositionPanel.svelte';
	import EditableText from '#lib/components/risks/EditableText.svelte';
	import PartPicker from '#lib/components/parts/PartPicker.svelte';
	import LinkedIssues from '#lib/components/risks/LinkedIssues.svelte';
	import ProjectRow from '#lib/components/projects/ProjectRow.svelte'; // added by projects
	import Score from '#lib/components/risks/Score.svelte';
	import { IMPACT, PROBABILITY, dispositionTone } from '#lib/components/risks/types.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const risk = $derived(data.risk);
	const accepted = $derived(risk.disposition === 'accepted');
	const realized = $derived(risk.disposition === 'realized');
	const closed = $derived(risk.disposition === 'closed');
	const live = $derived(!accepted && !realized && !closed);
	const reviewedBy = $derived(` · ${risk.lastReviewedByName}`);

	// Pages open for reading. EDIT reveals what is still pencil: everything while open, owner and
	// narrative while accepted, nothing once realized or closed. A realized risk is corrected
	// deliberately (`?correct=1`), each save with a reason.
	const editing = $derived((live || accepted) && isEditing(page.url));
	const editScored = $derived(editing && live);
	const correcting = $derived(realized && page.url.searchParams.get('correct') === '1');
	const editFields = $derived(editScored || correcting);
	const editNarrative = $derived(editing || correcting);

	let target = $state('');
	let editingAsset = $state(false);
	let editingNarrative = $state(false);
	let assetText = $state('');

	/** Save fields. A correction to a realized risk is logged with its reason. */
	async function patch(
		fields: Omit<Parameters<typeof opal.risks.update>[0], 'id'>
	): Promise<boolean> {
		try {
			if (correcting) {
				const reason = await askReason({
					title: `Correct ${risk.riskNumber}`,
					body: 'The earlier value stays in History with this reason.',
					action: 'CORRECT'
				});
				if (reason === null) return false;
				await opal.risks.correct({ id: risk.id, ...fields, reason });
			} else {
				await opal.risks.update({ id: risk.id, ...fields });
			}
			await invalidateAll();
			return true;
		} catch (e) {
			toastError(e);
			await invalidateAll();
			return false;
		}
	}

	/** Select that saves on change and snaps back when the change is refused or declined. */
	async function onSelect(
		e: Event & { currentTarget: HTMLSelectElement },
		field: 'ownerId' | 'probability' | 'impact' | 'residualProbability' | 'residualImpact',
		parse: (v: string) => number | null,
		current: number | null
	) {
		const el = e.currentTarget;
		const ok = await patch({ [field]: parse(el.value) } as Parameters<typeof patch>[0]);
		if (!ok) el.value = current === null ? '' : String(current);
	}
	const num = (v: string) => (v === '' ? null : Number(v));

	async function setAsset(partId: number | null, text: string | null): Promise<boolean> {
		const ok = await patch(partId !== null ? { assetPartId: partId } : { assetText: text });
		if (ok) editingAsset = false;
		return ok;
	}

	async function accept() {
		const rationale = await askReason({
			title: `Accept ${risk.riskNumber}`,
			body: `Signs ${risk.riskNumber} at score ${risk.score}${risk.residualScore !== null ? ` → ${risk.residualScore}` : ''} as the current user. Score and scenario then stay fixed until the acceptance is withdrawn.`,
			action: 'ACCEPT'
		});
		if (rationale === null) return;
		try {
			await opal.risks.accept({ id: risk.id, rationale });
			toast.success(`${risk.riskNumber} accepted`);
			await invalidateAll();
		} catch (e) {
			toastError(e);
			await invalidateAll();
		}
	}

	async function withdraw() {
		const reason = await askReason({
			title: `Withdraw acceptance of ${risk.riskNumber}`,
			body: `${risk.acceptedByName ?? 'The'} acceptance is withdrawn. The risk returns to OPEN and its score and scenario can change.`,
			action: 'WITHDRAW'
		});
		if (reason === null) return;
		try {
			await opal.risks.withdrawAcceptance({ id: risk.id, reason });
			await invalidateAll();
		} catch (e) {
			toastError(e);
		}
	}

	async function moveTo(
		disposition: 'closed' | 'open',
		title: string,
		action: string,
		body?: string
	) {
		const note = await askReason({ title, body, action });
		if (note === null) return;
		try {
			await opal.risks.setDisposition({ id: risk.id, disposition, note });
			await invalidateAll();
		} catch (e) {
			toastError(e);
		}
	}
	const close = () =>
		moveTo(
			'closed',
			`Close ${risk.riskNumber}`,
			'CLOSE',
			'The risk leaves the matrix and stays on record as closed.'
		);
	const reopen = () => moveTo('open', `Reopen ${risk.riskNumber}`, 'REOPEN');

	async function markReviewed() {
		try {
			await opal.risks.reviewStamp({ riskIds: [risk.id] });
			toast.success(`${risk.riskNumber} marked reviewed`);
			await invalidateAll();
		} catch (e) {
			toastError(e);
		}
	}

	async function remove() {
		const ok = await confirm({
			title: `Delete ${risk.riskNumber}`,
			body: 'Removes the risk from the register and the matrix. Linked issues are untouched; the audit log keeps its history.',
			action: 'DELETE',
			destructive: true
		});
		if (!ok) return;
		try {
			await opal.risks.delete({ id: risk.id });
			toast.success(`${risk.riskNumber} deleted`);
			await goto('/risks');
		} catch (e) {
			toastError(e);
		}
	}

	// Disposition moves from the edit panel. Closing and reopening have their own acts under MORE.
	const targets = $derived(
		RISK_DISPOSITIONS.filter((d) => d !== risk.disposition && d !== 'accepted' && d !== 'closed')
	);

	// The acceptance carries its own rationale, so that check does not block the move.
	const unmet = $derived(
		data.readiness.checks.filter((c) => !c.passed && c.key !== 'rationale_recorded')
	);
	const canAccept = $derived(live && unmet.length === 0);

	const moreItems = $derived<MoreItem[]>([
		{ label: 'ACCEPT', onselect: accept, when: canAccept },
		{ label: 'WITHDRAW ACCEPTANCE', onselect: withdraw, when: accepted },
		{ label: 'CLOSE', onselect: close, strike: true, when: live || accepted },
		{ label: 'REOPEN', onselect: reopen, when: closed },
		{ label: 'CORRECT RECORD', onselect: () => goto('?correct=1'), when: realized && !correcting },
		{ label: '+ NEW RISK', onselect: () => goto('/risks/new'), when: realized },
		{
			label: 'DELETE',
			onselect: remove,
			strike: true,
			when: live && risk.acceptedAt === null
		}
	]);
	const scenarioCheck = $derived(data.readiness.checks.find((c) => c.key === 'scenario_complete'));
	const SHORT: Record<string, string> = {
		scenario_complete: 'scenario',
		owner_assigned: 'owner',
		scored: 'score',
		rationale_recorded: 'rationale',
		lint_clean: 'lint'
	};

	const FIELD_LABELS: Record<string, string> = {
		probability: 'Probability',
		impact: 'Impact',
		residualProbability: 'Residual P',
		residualImpact: 'Residual I',
		disposition: 'Disposition',
		owner: 'Owner',
		condition: 'Condition',
		departure: 'Departure',
		consequence: 'Consequence',
		asset: 'Asset'
	};
	const historyColumns: Column<RiskHistoryRow>[] = [
		{ key: 'at', label: 'When', width: '10rem' },
		{ key: 'by', label: 'By', width: '10rem' },
		{ key: 'changes', label: 'Change' },
		{ key: 'note', label: 'Note' }
	];
	const show = (v: string | number | null) => (v === null || v === '' ? '—' : String(v));
</script>

<PageHeader
	title={risk.title}
	identifier={risk.riskNumber}
	crumbs={[{ label: 'Risks', href: '/risks' }, { label: risk.riskNumber }]}
>
	{#snippet heading()}
		<h1 class="min-w-0 text-lg font-semibold tracking-tight [&>div]:items-center">
			<EditableText
				label="title"
				value={risk.title}
				maxlength={255}
				readonly={!editFields}
				onsave={(v) => (v ? patch({ title: v }) : Promise.resolve(false))}
			/>
		</h1>
	{/snippet}
	{#snippet state()}
		<Score
			class="text-lg font-semibold"
			score={risk.score}
			severity={risk.severity}
			residual={risk.residualScore}
			residualSeverity={risk.residualSeverity}
		/>
		<State value={risk.disposition} tone={dispositionTone(risk.disposition)} />
	{/snippet}
	{#snippet actions()}
		{#if live || accepted}
			<Button size="sm" onclick={markReviewed}>MARK REVIEWED</Button>
			<EditToggle />
		{:else if realized}
			{#if risk.realizedIssueId}
				<Button size="sm" href={`/issues/${risk.realizedIssueId}`}
					>{risk.realizedIssueNumber}</Button
				>
			{/if}
			{#if correcting}
				<Button size="sm" variant="default" href={queryHref({ correct: null })}>DONE</Button>
			{/if}
		{/if}
		<MoreMenu items={moreItems} />
	{/snippet}
</PageHeader>

<div class="grid grid-cols-[minmax(0,1fr)] gap-4 p-4">
	<div
		class={[
			'rounded-lg border border-border bg-card px-3 py-2 text-sm',
			!risk.statement && 'font-mono text-xs text-muted-foreground'
		]}
	>
		{#if risk.statement}
			{risk.statement}
		{:else}
			scenario incomplete — {scenarioCheck?.detail ?? 'condition · departure · asset · consequence'}
		{/if}
	</div>

	<div class="grid grid-cols-1 items-start gap-4 xl:grid-cols-2">
		<div class="grid grid-cols-1 gap-4">
			<Section title="Scenario">
				<DetailTable>
					<DetailRow label="Condition">
						<EditableText
							label="condition"
							value={risk.condition}
							lint="condition"
							readonly={!editFields}
							onsave={(v) => patch({ condition: v })}
						/>
					</DetailRow>
					<DetailRow label="Departure">
						<EditableText
							label="departure"
							value={risk.departure}
							lint="departure"
							readonly={!editFields}
							onsave={(v) => patch({ departure: v })}
						/>
					</DetailRow>
					<DetailRow label="Asset">
						{#if editingAsset && editFields}
							<div class="flex flex-wrap items-center gap-2">
								<PartPicker trigger={pickPart} onselect={(p) => p && setAsset(p.id, null)} />
								<span class="label">or</span>
								<Input
									class="w-64"
									aria-label="Asset name"
									bind:value={assetText}
									maxlength={255}
									placeholder="schedule, test campaign"
									onkeydown={(e) => {
										if (e.key === 'Enter' && assetText.trim()) setAsset(null, assetText.trim());
										else if (e.key === 'Escape') editingAsset = false;
									}}
								/>
								<Button
									size="xs"
									disabled={!assetText.trim()}
									onclick={() => setAsset(null, assetText.trim())}>SAVE</Button
								>
								<Button size="xs" variant="outline" onclick={() => (editingAsset = false)}
									>CANCEL</Button
								>
							</div>
						{:else}
							<div class="flex items-start gap-2">
								<div class="min-w-0 flex-1">
									{#if risk.assetPartId}
										<a
											class="font-mono text-info hover:underline"
											href={`/parts/${risk.assetPartId}`}>{risk.assetPartNumber ?? 'no PN'}</a
										>
										{risk.assetPartName}
									{:else if risk.assetText}
										{risk.assetText}
									{:else}
										<span class="text-muted-foreground">—</span>
									{/if}
								</div>
								{#if editFields}
									<button
										type="button"
										class="label shrink-0 hover:text-foreground"
										aria-label="Edit asset"
										onclick={() => {
											assetText = risk.assetText ?? '';
											editingAsset = true;
										}}>EDIT</button
									>
								{/if}
							</div>
						{/if}
					</DetailRow>
					<DetailRow label="Consequence">
						<EditableText
							label="consequence"
							value={risk.consequence}
							lint="consequence"
							readonly={!editFields}
							onsave={(v) => patch({ consequence: v })}
						/>
					</DetailRow>
				</DetailTable>
			</Section>

			{#if !risk.description && !editingNarrative}
				<EmptyLine
					label="Narrative"
					onadd={editNarrative ? () => (editingNarrative = true) : undefined}
				/>
			{:else}
				<Section title="Narrative">
					<div class="px-3 py-2">
						<EditableText
							label="narrative"
							value={risk.description}
							multiline
							readonly={!editNarrative}
							bind:editing={editingNarrative}
							onsave={(v) => patch({ description: v })}
						>
							{#snippet display(text)}
								<!-- eslint-disable-next-line svelte/no-at-html-tags -->
								<div class="prose-opal">{@html markdown(text)}</div>
							{/snippet}
						</EditableText>
					</div>
				</Section>
			{/if}
		</div>

		<div class="grid grid-cols-1 gap-4">
			<Section title="Scoring">
				<DetailTable>
					<ProjectRow id={risk.projectId} code={risk.projectCode} name={risk.projectName} />
					<!-- added by projects -->
					<DetailRow label="Owner">
						{#if editNarrative}
							<NativeSelect
								aria-label="Owner"
								value={risk.ownerId === null ? '' : String(risk.ownerId)}
								onchange={(e) => onSelect(e, 'ownerId', num, risk.ownerId)}
							>
								<NativeSelectOption value="">—</NativeSelectOption>
								{#each data.owners as o (o.id)}<NativeSelectOption value={String(o.id)}
										>{o.name}</NativeSelectOption
									>{/each}
							</NativeSelect>
						{:else}{risk.ownerName ?? '—'}{/if}
					</DetailRow>
					<DetailRow label="Probability">
						{#if editFields}
							<NativeSelect
								aria-label="Probability"
								value={String(risk.probability)}
								onchange={(e) => onSelect(e, 'probability', num, risk.probability)}
							>
								{#each PROBABILITY as p (p.value)}<NativeSelectOption value={String(p.value)}
										>{p.label}</NativeSelectOption
									>{/each}
							</NativeSelect>
						{:else}{PROBABILITY.find((p) => p.value === risk.probability)?.label}{/if}
					</DetailRow>
					<DetailRow label="Impact">
						{#if editFields}
							<NativeSelect
								aria-label="Impact"
								value={String(risk.impact)}
								onchange={(e) => onSelect(e, 'impact', num, risk.impact)}
							>
								{#each IMPACT as p (p.value)}<NativeSelectOption value={String(p.value)}
										>{p.label}</NativeSelectOption
									>{/each}
							</NativeSelect>
						{:else}{IMPACT.find((p) => p.value === risk.impact)?.label}{/if}
					</DetailRow>
					<DetailRow label="Residual P × I">
						{#if editFields}
							<div class="flex items-center gap-2">
								<NativeSelect
									aria-label="Residual probability"
									value={risk.residualProbability === null ? '' : String(risk.residualProbability)}
									onchange={(e) =>
										onSelect(e, 'residualProbability', num, risk.residualProbability)}
								>
									<NativeSelectOption value="">—</NativeSelectOption>
									{#each [1, 2, 3, 4, 5] as v (v)}<NativeSelectOption value={String(v)}
											>{v}</NativeSelectOption
										>{/each}
								</NativeSelect>
								<span class="text-muted-foreground">×</span>
								<NativeSelect
									aria-label="Residual impact"
									value={risk.residualImpact === null ? '' : String(risk.residualImpact)}
									onchange={(e) => onSelect(e, 'residualImpact', num, risk.residualImpact)}
								>
									<NativeSelectOption value="">—</NativeSelectOption>
									{#each [1, 2, 3, 4, 5] as v (v)}<NativeSelectOption value={String(v)}
											>{v}</NativeSelectOption
										>{/each}
								</NativeSelect>
							</div>
						{:else if risk.residualProbability !== null && risk.residualImpact !== null}
							<span class="font-mono">{risk.residualProbability} × {risk.residualImpact}</span>
						{:else}<span class="text-muted-foreground">—</span>{/if}
					</DetailRow>
					<DetailRow label="Score" mono>
						<Score
							score={risk.score}
							severity={risk.severity}
							residual={risk.residualScore}
							residualSeverity={risk.residualSeverity}
						/>
					</DetailRow>
				</DetailTable>
			</Section>

			<Section title="Disposition">
				<DetailTable>
					<DetailRow label="State">
						<div class="flex flex-wrap items-center gap-3">
							<State value={risk.disposition} tone={dispositionTone(risk.disposition)} />
							{#if editScored}
								<NativeSelect aria-label="Change disposition" size="sm" bind:value={target}>
									<NativeSelectOption value="">Change to…</NativeSelectOption>
									{#each targets as d (d)}<NativeSelectOption value={d}
											>{d.toUpperCase()}</NativeSelectOption
										>{/each}
								</NativeSelect>
							{/if}
						</div>
					</DetailRow>
					{#if risk.disposition === 'watch' || risk.watchObservable || risk.watchThreshold}
						<DetailRow label="Watch observable">
							<EditableText
								label="watch observable"
								mono
								readonly={!editFields}
								value={risk.watchObservable}
								maxlength={255}
								onsave={(v) => patch({ watchObservable: v })}
							/>
						</DetailRow>
						<DetailRow label="Watch threshold">
							<EditableText
								label="watch threshold"
								mono
								readonly={!editFields}
								value={risk.watchThreshold}
								maxlength={255}
								onsave={(v) => patch({ watchThreshold: v })}
							/>
						</DetailRow>
						<DetailRow label="Watch contingency">
							<EditableText
								label="watch contingency"
								mono
								readonly={!editFields}
								value={risk.watchContingency}
								onsave={(v) => patch({ watchContingency: v })}
							/>
						</DetailRow>
					{/if}
					{#if risk.realizedIssueId}
						<DetailRow label="Realized as">
							<a
								class="font-mono text-info hover:underline"
								href={`/issues/${risk.realizedIssueId}`}>{risk.realizedIssueNumber}</a
							>
						</DetailRow>
					{/if}
					{#if accepted}
						<DetailRow label="Accepted">
							<span class="font-mono text-xs"
								>{risk.acceptedByName ?? '—'} · <Timestamp value={risk.acceptedAt} /></span
							>
						</DetailRow>
						<DetailRow label="Rationale" value={risk.acceptanceRationale} />
					{:else if risk.acceptedAt}
						<DetailRow label="Last accepted">
							<span class="font-mono text-xs"
								>{risk.acceptedByName ?? '—'} · <Timestamp value={risk.acceptedAt} /></span
							>
						</DetailRow>
					{/if}
					{#if live && unmet.length}
						<DetailRow label="Acceptance">
							<span class="font-mono text-xs text-muted-foreground"
								>needs {unmet.map((c) => SHORT[c.key] ?? c.key).join(', ')}</span
							>
						</DetailRow>
					{/if}
				</DetailTable>
				{#if target && editScored}
					<DispositionPanel
						{risk}
						target={target as RiskDisposition}
						ondone={() => (target = '')}
					/>
				{/if}
			</Section>

			<LinkedIssues {risk} />

			<References {risk} />

			<Section title="Record">
				{#snippet actions()}
					<Button size="xs" variant="ghost" href={`/audit?entity=risk&record=${risk.id}`}
						>AUDIT</Button
					>
				{/snippet}
				<DetailTable>
					<DetailRow label="Last reviewed">
						{#if risk.lastReviewedAt}
							<span class="font-mono text-xs"
								><Timestamp
									value={risk.lastReviewedAt}
								/>{#if risk.lastReviewedByName}{reviewedBy}{/if}</span
							>
						{:else}
							<span class="text-muted-foreground">—</span>
						{/if}
					</DetailRow>
					<DetailRow label="Created"><Timestamp value={risk.createdAt} /></DetailRow>
					<DetailRow label="Updated"><Timestamp value={risk.updatedAt} /></DetailRow>
				</DetailTable>
			</Section>
		</div>
	</div>
	{#if data.history.length}
		<Section title="History" count={data.history.length}>
			<DataTable rows={data.history} columns={historyColumns} emptyLabel="History" dense>
				{#snippet cell(h, col)}
					{#if col.key === 'at'}
						<Timestamp value={h.at} />
					{:else if col.key === 'by'}
						{h.by ?? '—'}
					{:else if col.key === 'changes'}
						<ul class="grid grid-cols-1 gap-0.5 font-mono text-xs">
							{#each h.changes as c (c.field)}
								<li class="break-words">
									<span class="text-muted-foreground"
										>{(FIELD_LABELS[c.field] ?? c.field).toUpperCase()}</span
									>
									{h.action === 'update' ? `${show(c.from)} → ${show(c.to)}` : show(c.to)}
								</li>
							{/each}
						</ul>
					{:else}
						{h.note ?? '—'}
					{/if}
				{/snippet}
			</DataTable>
		</Section>
	{:else}
		<EmptyLine label="History" />
	{/if}
</div>

{#snippet pickPart({ props }: { props: Record<string, unknown> })}
	<Button {...props} variant="outline" size="sm">PICK PART</Button>
{/snippet}
