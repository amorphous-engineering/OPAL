<script lang="ts">
	import { goto } from '$app/navigation';
	import { opal } from '#lib/api.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { MarkdownField } from '#lib/components/markdown/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import {
		DetailRow,
		DetailTable,
		PageHeader,
		Section,
		toastError,
		ErrorBanner
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
			...(type === 'bug'
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

	function submitForm() {
		formEl?.requestSubmit();
	}
</script>

<PageHeader title="New issue" crumbs={[{ label: 'Issues', href: '/issues' }, { label: 'New' }]} />

<form
	bind:this={formEl}
	class="grid max-w-5xl grid-cols-1 gap-4 p-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]"
	onsubmit={submit}
>
	<div class="grid grid-cols-1 content-start gap-3">
		<div class="grid grid-cols-1 gap-1.5">
			<Label for="project">Project</Label>
			<ProjectSelect id="project" bind:value={projectId} />
		</div>

		<div class="grid grid-cols-1 gap-1.5">
			<Label for="title">Title</Label>
			<Input id="title" bind:value={title} required maxlength={255} autofocus />
		</div>

		<div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
			<div class="grid grid-cols-1 gap-1.5">
				<Label for="type">Type</Label>
				<NativeSelect id="type" bind:value={type} class="w-full">
					{#each ISSUE_TYPES as t (t)}
						<NativeSelectOption value={t}>{stateLabel(t)}</NativeSelectOption>
					{/each}
				</NativeSelect>
			</div>
			<div class="grid grid-cols-1 gap-1.5">
				<Label for="priority">Priority</Label>
				<NativeSelect id="priority" bind:value={priority} class="w-full">
					{#each ISSUE_PRIORITIES as p (p)}
						<NativeSelectOption value={p}>{stateLabel(p)}</NativeSelectOption>
					{/each}
				</NativeSelect>
			</div>
		</div>

		<div class="grid grid-cols-1 gap-1.5">
			<Label for="containment">Containment</Label>
			<NativeSelect id="containment" bind:value={containment} class="w-full">
				{#each CONTAINMENTS as c (c)}
					<NativeSelectOption value={c}>{CONTAINMENT_OPTION[c]}</NativeSelectOption>
				{/each}
			</NativeSelect>
		</div>

		<div class="grid grid-cols-1 gap-1.5">
			<Label for="description">Description</Label>
			<MarkdownField id="description" bind:value={description} minRows={4} onsubmit={submitForm} />
		</div>

		{#if type === 'non_conformance'}
			<div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
				<div class="grid grid-cols-1 gap-1.5">
					<Label for="should-be">Should be</Label>
					<MarkdownField id="should-be" bind:value={shouldBe} minRows={3} onsubmit={submitForm} />
				</div>
				<div class="grid grid-cols-1 gap-1.5">
					<Label for="actual">Is</Label>
					<MarkdownField id="actual" bind:value={actual} minRows={3} onsubmit={submitForm} />
				</div>
			</div>
		{:else if type === 'bug'}
			<div class="grid grid-cols-1 gap-1.5">
				<Label for="steps">Steps to reproduce</Label>
				<MarkdownField id="steps" bind:value={steps} minRows={3} onsubmit={submitForm} />
			</div>
			<div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
				<div class="grid grid-cols-1 gap-1.5">
					<Label for="expected">Expected behavior</Label>
					<MarkdownField id="expected" bind:value={expected} minRows={2} onsubmit={submitForm} />
				</div>
				<div class="grid grid-cols-1 gap-1.5">
					<Label for="actual-behavior">Actual behavior</Label>
					<MarkdownField
						id="actual-behavior"
						bind:value={actualBehavior}
						minRows={2}
						onsubmit={submitForm}
					/>
				</div>
			</div>
		{:else if type === 'improvement'}
			<div class="grid grid-cols-1 gap-1.5">
				<Label for="benefit">Expected benefit</Label>
				<MarkdownField id="benefit" bind:value={benefit} minRows={2} onsubmit={submitForm} />
			</div>
		{/if}

		<ErrorBanner message={error} />
		<div class="flex gap-2">
			<Button type="submit" disabled={busy || !title.trim() || !projectId}>CREATE</Button>
			<Button variant="outline" href="/issues">CANCEL</Button>
		</div>
	</div>

	<div class="grid grid-cols-1 content-start gap-3">
		<Section title="Assignment">
			<div class="grid grid-cols-1 gap-1.5 p-3">
				<Label for="assignee">Assigned to</Label>
				<NativeSelect id="assignee" bind:value={assignee} class="w-full">
					<NativeSelectOption value="">Unassigned</NativeSelectOption>
					{#each data.assignees as a (a.id)}
						<NativeSelectOption value={String(a.id)}>{a.name}</NativeSelectOption>
					{/each}
				</NativeSelect>
			</div>
		</Section>

		<Section title="Links">
			<DetailTable>
				<DetailRow label="Part">
					{@render link(part, 'part', (c) => (part = c))}
				</DetailRow>
				<DetailRow label="Execution">
					{@render link(execution, 'execution', (c) => {
						execution = c;
						// A different execution invalidates its step anchor.
						step = null;
					})}
				</DetailRow>
				{#if step}
					<DetailRow label="Raised at" mono>
						{step.label}
						<button
							type="button"
							class="ml-2 text-xs text-info uppercase hover:underline"
							onclick={() => (step = null)}>CLEAR</button
						>
					</DetailRow>
				{/if}
			</DetailTable>
		</Section>
	</div>
</form>

{#snippet link(current: Ctx | null, kind: 'part' | 'execution', set: (c: Ctx | null) => void)}
	{#if current}
		<span class="flex items-baseline gap-2">
			{#if current.sub}<span class="mono text-info">{current.sub}</span>{/if}
			<span class={kind === 'execution' ? 'mono' : ''}>{current.label}</span>
			<button
				type="button"
				class="ml-auto font-mono text-xs tracking-wider text-info uppercase hover:underline"
				onclick={() => set(null)}>CLEAR</button
			>
		</span>
	{:else if kind === 'part'}
		<PartPicker
			placeholder="Search parts"
			onselect={(p) => {
				if (!p) return;
				const row = p as unknown as Record<string, string | null>;
				set({ id: p.id, label: p.name, sub: row.internalPn ?? row.internal_pn });
			}}
		/>
	{:else}
		<span class="text-muted-foreground">—</span>
	{/if}
{/snippet}
