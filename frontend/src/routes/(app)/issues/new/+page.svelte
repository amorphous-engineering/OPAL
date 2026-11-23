<script lang="ts">
	// Raised from a run, the form asks only for a title (CLAUDE.md rule 9): the work order, step,
	// part and person come with it as facts, type and containment arrive filled in, and the rest
	// is written on the issue under EDIT. Raised from the desk, it is the whole form.
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { opal } from '#lib/api.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { MarkdownField } from '#lib/components/markdown/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import {
		Field,
		FormKeys,
		NextNumber,
		needs,
		PageHeader,
		Section,
		toastError
	} from '#lib/components/opal/index.js';
	import ProjectSelect from '#lib/components/projects/ProjectSelect.svelte'; // added by projects
	import PartPicker from '#lib/components/parts/PartPicker.svelte';
	import { CONTAINMENT_OPTION } from '#lib/components/issues/issues.js';
	import {
		CONTAINMENTS,
		ISSUE_PRIORITIES,
		ISSUE_TYPES,
		type Containment,
		type IssuePriority,
		type IssueType
	} from '@opal/shared';
	import { stateLabel } from '#lib/format.js';
	import type { Ctx } from './+page.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const fromRun = $derived(!!data.ctx.execution);
	// The work order carries the project; asking for it again could only disagree.
	const fixedProject = $derived(fromRun && !!data.projectId);

	// Reset when the invoking context (the query string) changes.
	let projectId = $state(0); // added by projects
	let part = $state<Ctx | null>(null);
	let execution = $state<Ctx | null>(null);
	let step = $state<Ctx | null>(null);
	let title = $state('');
	let type = $state<IssueType>('task');
	let priority = $state<IssuePriority>('medium');
	let containment = $state<Containment>('advisory');
	let description = $state('');
	let shouldBe = $state('');
	let actual = $state('');
	let steps = $state('');
	let expected = $state('');
	let actualBehavior = $state('');
	let benefit = $state('');
	let assignee = $state('');
	let busy = $state(false);
	let error = $state<string | null>(null);

	$effect(() => {
		part = data.ctx.part;
		execution = data.ctx.execution;
		step = data.ctx.step;
		title = data.defaults.title;
		type = data.defaults.type as IssueType;
		containment = data.defaults.containment as Containment;
		if (data.projectId) projectId = data.projectId; // added by projects
	});

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		if (!title.trim() || !projectId) return;
		busy = true;
		error = null;
		const text = (v: string) => v.trim() || null;
		const body = {
			projectId, // added by projects
			title: title.trim(),
			description: text(description),
			issueType: type,
			priority,
			containment,
			executionId: execution?.id ?? null,
			raisedStepId: step?.id ?? null,
			containmentStepId: step && containment !== 'advisory' ? step.id : null,
			assignedToId: assignee ? Number(assignee) : null,
			links: part ? [{ kind: 'part' as const, targetId: part.id }] : [],
			...(type === 'non_conformance' ? { shouldBe: text(shouldBe), actual: text(actual) } : {}),
			...(type === 'anomaly'
				? {
						stepsToReproduce: text(steps),
						expectedBehavior: text(expected),
						actualBehavior: text(actualBehavior)
					}
				: {}),
			...(type === 'improvement' ? { expectedBenefit: text(benefit) } : {})
		};
		try {
			const issue = await opal.issues.create(body);
			await goto(`/issues/${issue.id}`);
		} catch (err) {
			error = err instanceof Error ? err.message : 'Could not create the issue';
			toastError(err);
		} finally {
			busy = false;
		}
	}

	let formEl = $state<HTMLFormElement | null>(null);
	const missing = $derived(needs({ project: projectId, title: title.trim() }));

	function submitForm() {
		formEl?.requestSubmit();
	}
</script>

<PageHeader title="New issue" crumbs={[{ label: 'Issues', href: '/issues' }, { label: 'New' }]} />

<form bind:this={formEl} class="grid max-w-3xl grid-cols-1 gap-3 p-4" onsubmit={submit}>
	<Section title="Issue">
		<div class="grid grid-cols-1 gap-3 p-3">
			<NextNumber kind="issue" />
			{#if !fixedProject}
				<Field label="Project" for="project" required>
					<ProjectSelect id="project" bind:value={projectId} />
				</Field>
			{/if}
			{#if execution}
				<!-- Carried from the run, worded as the issue page words it once raised. -->
				<div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
					<Field label="Work order">
						<span class="font-mono text-sm">{execution.label}{step ? ` OP ${step.label}` : ''}</span
						>
					</Field>
					{#if part}
						<Field label="Part">
							<span class="text-sm"
								>{#if part.sub}<span class="mono text-info">{part.sub}</span>
								{/if}{part.label}</span
							>
						</Field>
					{/if}
					<Field label="Raised by">
						<span class="text-sm">{page.data.user?.name ?? '—'}</span>
					</Field>
				</div>
			{/if}

			<Field label="Title" for="title" required>
				<Input id="title" bind:value={title} required maxlength={255} autofocus />
			</Field>

			<div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
				<Field label="Type" for="type">
					<NativeSelect id="type" bind:value={type} class="w-full">
						{#each ISSUE_TYPES as t (t)}
							<NativeSelectOption value={t}>{stateLabel(t)}</NativeSelectOption>
						{/each}
					</NativeSelect>
				</Field>
				{#if fromRun}
					<!-- Containment needs a step to anchor it; raised on the whole work order it starts
					     advisory and is widened on the issue. -->
					{#if step}
						<Field label="Containment" for="containment">
							<NativeSelect id="containment" bind:value={containment} class="w-full">
								{#each CONTAINMENTS as c (c)}
									<NativeSelectOption value={c}>{CONTAINMENT_OPTION[c]}</NativeSelectOption>
								{/each}
							</NativeSelect>
						</Field>
					{/if}
				{:else}
					<Field label="Priority" for="priority">
						<NativeSelect id="priority" bind:value={priority} class="w-full">
							{#each ISSUE_PRIORITIES as p (p)}
								<NativeSelectOption value={p}>{stateLabel(p)}</NativeSelectOption>
							{/each}
						</NativeSelect>
					</Field>
					<Field label="Assigned to" for="assignee">
						<NativeSelect id="assignee" bind:value={assignee} class="w-full">
							<NativeSelectOption value="">—</NativeSelectOption>
							{#each data.assignees as a (a.id)}
								<NativeSelectOption value={String(a.id)}>{a.name}</NativeSelectOption>
							{/each}
						</NativeSelect>
					</Field>
				{/if}
			</div>

			{#if !fromRun}
				<Field label="Containment" for="containment">
					<NativeSelect id="containment" bind:value={containment} class="w-full">
						{#each CONTAINMENTS as c (c)}
							<NativeSelectOption value={c}>{CONTAINMENT_OPTION[c]}</NativeSelectOption>
						{/each}
					</NativeSelect>
				</Field>

				<Field label="Description" for="description">
					<MarkdownField
						quiet
						id="description"
						bind:value={description}
						minRows={4}
						onsubmit={submitForm}
					/>
				</Field>

				{#if type === 'non_conformance'}
					<div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
						<Field label="Should be" for="should-be">
							<MarkdownField
								quiet
								id="should-be"
								bind:value={shouldBe}
								minRows={3}
								onsubmit={submitForm}
							/>
						</Field>
						<Field label="Is" for="actual">
							<MarkdownField
								quiet
								id="actual"
								bind:value={actual}
								minRows={3}
								onsubmit={submitForm}
							/>
						</Field>
					</div>
				{:else if type === 'anomaly'}
					<Field label="Steps to reproduce" for="steps">
						<MarkdownField quiet id="steps" bind:value={steps} minRows={3} onsubmit={submitForm} />
					</Field>
					<div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
						<Field label="Expected behavior" for="expected">
							<MarkdownField
								quiet
								id="expected"
								bind:value={expected}
								minRows={2}
								onsubmit={submitForm}
							/>
						</Field>
						<Field label="Observed behavior" for="actual-behavior">
							<MarkdownField
								quiet
								id="actual-behavior"
								bind:value={actualBehavior}
								minRows={2}
								onsubmit={submitForm}
							/>
						</Field>
					</div>
				{:else if type === 'improvement'}
					<Field label="Expected benefit" for="benefit">
						<MarkdownField
							quiet
							id="benefit"
							bind:value={benefit}
							minRows={2}
							onsubmit={submitForm}
						/>
					</Field>
				{/if}

				<Field label="Part" for="issue-part">
					{#if part}
						<span class="flex items-center gap-2 text-sm">
							{#if part.sub}<span class="mono text-info">{part.sub}</span>{/if}
							<span>{part.label}</span>
							<Button size="sm" variant="outline" onclick={() => (part = null)}>CLEAR</Button>
						</span>
					{:else}
						<div class="max-w-sm">
							<PartPicker
								id="issue-part"
								placeholder="Search parts"
								onselect={(p) => {
									if (!p) return;
									const row = p as unknown as Record<string, string | null>;
									part = { id: p.id, label: p.name, sub: row.internalPn ?? row.internal_pn };
								}}
							/>
						</div>
					{/if}
				</Field>
			{/if}
		</div>
	</Section>
	<FormKeys submit="RAISE" cancel="/issues" {missing} {busy} {error} />
</form>
