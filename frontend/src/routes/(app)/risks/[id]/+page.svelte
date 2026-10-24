<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
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
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import { opal } from '#lib/api.js';
	import References from '#lib/components/risks/References.svelte';
	import {
		RISK_DISPOSITIONS,
		RISK_SIGNATURE_FIELDS,
		type RiskDisposition,
		type RiskHistoryRow
	} from '@opal/shared';
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
	const terminal = $derived(risk.disposition === 'realized');

	let target = $state('');
	let editingAsset = $state(false);
	let editingNarrative = $state(false);
	let assetText = $state('');

	/** PATCH fields. Editing the signed scenario or score withdraws an acceptance, so ask first. */
	async function patch(fields: Omit<Parameters<typeof opal.risks.update>[0], 'id'>): Promise<boolean> {
		if (
			accepted &&
			Object.keys(fields).some((k) => (RISK_SIGNATURE_FIELDS as readonly string[]).includes(k))
		) {
			const ok = await confirm({
				title: `Withdraw acceptance of ${risk.riskNumber}`,
				body: `Changing the scenario or score withdraws ${risk.acceptedByName ?? 'the'} acceptance. The risk returns to OPEN.`,
				action: 'CHANGE'
			});
			if (!ok) return false;
		}
		try {
			const r = await opal.risks.update({ id: risk.id, ...fields });
			if (r.acceptanceInvalidated)
				toast.warning(`Acceptance withdrawn; ${risk.riskNumber} is open`);
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
		const ok = await confirm({
			title: `Accept ${risk.riskNumber}`,
			body: `Signs ${risk.riskNumber} at score ${risk.score}${risk.residualScore !== null ? ` → ${risk.residualScore}` : ''} as the current user. Changing the scenario or score afterwards withdraws the acceptance.`,
			action: 'ACCEPT'
		});
		if (!ok) return;
		try {
			await opal.risks.accept({ id: risk.id });
			toast.success(`${risk.riskNumber} accepted`);
			await invalidateAll();
		} catch (e) {
			toastError(e);
			await invalidateAll();
		}
	}

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

	const targets = $derived(RISK_DISPOSITIONS.filter((d) => d !== risk.disposition && d !== 'accepted'));

	const unmet = $derived(data.readiness.checks.filter((c) => !c.passed));
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
		owner: 'Owner'
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
		<Button size="sm" variant="ghost" href={`/audit?entity=risk&record=${risk.id}`}>AUDIT</Button>
		<Button size="sm" variant="outline" onclick={markReviewed}>MARK REVIEWED</Button>
		<Button size="sm" variant="destructive" onclick={remove}>DELETE</Button>
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
							onsave={(v) => patch({ condition: v })}
						/>
					</DetailRow>
					<DetailRow label="Departure">
						<EditableText
							label="departure"
							value={risk.departure}
							lint="departure"
							onsave={(v) => patch({ departure: v })}
						/>
					</DetailRow>
					<DetailRow label="Asset">
						{#if editingAsset}
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
								<button
									type="button"
									class="label shrink-0 hover:text-foreground"
									aria-label="Edit asset"
									onclick={() => {
										assetText = risk.assetText ?? '';
										editingAsset = true;
									}}>EDIT</button
								>
							</div>
						{/if}
					</DetailRow>
					<DetailRow label="Consequence">
						<EditableText
							label="consequence"
							value={risk.consequence}
							lint="consequence"
							onsave={(v) => patch({ consequence: v })}
						/>
					</DetailRow>
				</DetailTable>
			</Section>

			{#if !risk.description && !editingNarrative}
				<EmptyLine label="Narrative" onadd={() => (editingNarrative = true)} />
			{:else}
				<Section title="Narrative">
					<div class="px-3 py-2">
						<EditableText
							label="narrative"
							value={risk.description}
							multiline
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
					<ProjectRow id={risk.projectId} code={risk.projectCode} name={risk.projectName} /> <!-- added by projects -->
					<DetailRow label="Owner">
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
					</DetailRow>
					<DetailRow label="Probability">
						<NativeSelect
							aria-label="Probability"
							value={String(risk.probability)}
							onchange={(e) => onSelect(e, 'probability', num, risk.probability)}
						>
							{#each PROBABILITY as p (p.value)}<NativeSelectOption value={String(p.value)}
									>{p.label}</NativeSelectOption
								>{/each}
						</NativeSelect>
					</DetailRow>
					<DetailRow label="Impact">
						<NativeSelect
							aria-label="Impact"
							value={String(risk.impact)}
							onchange={(e) => onSelect(e, 'impact', num, risk.impact)}
						>
							{#each IMPACT as p (p.value)}<NativeSelectOption value={String(p.value)}
									>{p.label}</NativeSelectOption
								>{/each}
						</NativeSelect>
					</DetailRow>
					<DetailRow label="Residual P × I">
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
							{#if !terminal}
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
								value={risk.watchObservable}
								maxlength={255}
								onsave={(v) => patch({ watchObservable: v })}
							/>
						</DetailRow>
						<DetailRow label="Watch threshold">
							<EditableText
								label="watch threshold"
								mono
								value={risk.watchThreshold}
								maxlength={255}
								onsave={(v) => patch({ watchThreshold: v })}
							/>
						</DetailRow>
						<DetailRow label="Watch contingency">
							<EditableText
								label="watch contingency"
								mono
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
					{:else if !terminal}
						<DetailRow label="Acceptance rationale">
							<EditableText
								label="acceptance rationale"
								multiline
								value={risk.acceptanceRationale}
								onsave={(v) => patch({ acceptanceRationale: v })}
							/>
						</DetailRow>
						{#if risk.acceptedAt}
							<DetailRow label="Last accepted">
								<span class="font-mono text-xs"
									>{risk.acceptedByName ?? '—'} · <Timestamp value={risk.acceptedAt} /></span
								>
							</DetailRow>
						{/if}
					{/if}
				</DetailTable>
				{#if target && !terminal}
					<DispositionPanel {risk} target={target as RiskDisposition} ondone={() => (target = '')} />
				{/if}
				{#if !accepted && !terminal}
					<div class="flex flex-wrap items-center gap-3 border-t border-border px-3 py-2">
						<Button size="sm" onclick={accept} disabled={!data.readiness.ready}
							>ACCEPT {risk.riskNumber}</Button
						>
						{#if unmet.length}
							<span class="font-mono text-xs text-muted-foreground"
								>needs {unmet.map((c) => SHORT[c.key] ?? c.key).join(', ')}</span
							>
						{/if}
					</div>
				{/if}
			</Section>

			<LinkedIssues {risk} />

			<References {risk} />

			<Section title="Record">
				<DetailTable>
					<DetailRow label="Last reviewed">
						{#if risk.lastReviewedAt}
							<span class="font-mono text-xs"
								><Timestamp value={risk.lastReviewedAt} />{#if risk.lastReviewedByName}
									· {risk.lastReviewedByName}{/if}</span
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
								<li class="whitespace-nowrap">
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
