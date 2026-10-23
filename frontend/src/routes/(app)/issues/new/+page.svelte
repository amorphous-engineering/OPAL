<script lang="ts">
	import { goto } from '$app/navigation';
	import { api } from '#lib/api.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import {
		DetailRow,
		DetailTable,
		PageHeader,
		Section,
		toastError
	} from '#lib/components/opal/index.js';
	import EntityPicker from '#lib/components/issues/EntityPicker.svelte';
	import {
		CONTAINMENTS,
		CONTAINMENT_OPTION,
		ISSUE_TYPES,
		PRIORITIES,
		type Issue
	} from '#lib/components/issues/issues.js';
	import { stateLabel } from '#lib/format.js';
	import type { Ctx } from './+page.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	// Reset when the invoking context (the query string) changes.
	let part = $state<Ctx | null>(null);
	let procedure = $state<Ctx | null>(null);
	let execution = $state<Ctx | null>(null);
	let step = $state<Ctx | null>(null);
	let title = $state('');
	let type = $state('task');
	let priority = $state('medium');
	let containment = $state('advisory');
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
		procedure = data.ctx.procedure;
		execution = data.ctx.execution;
		step = data.ctx.step;
		title = data.defaults.title;
		type = data.defaults.type;
		containment = data.defaults.containment;
	});

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		if (!title.trim()) return;
		busy = true;
		error = null;
		const body: Record<string, unknown> = {
			title: title.trim(),
			description: description.trim() || null,
			issue_type: type,
			priority,
			containment,
			part_id: part?.id ?? null,
			procedure_id: procedure?.id ?? null,
			procedure_instance_id: execution?.id ?? null,
			raised_step_id: step?.id ?? null,
			containment_step_id: step && containment !== 'advisory' ? step.id : null,
			assigned_to_id: assignee ? Number(assignee) : null
		};
		if (type === 'non_conformance') {
			body.should_be = shouldBe.trim() || null;
			body.actual = actual.trim() || null;
		} else if (type === 'bug') {
			body.steps_to_reproduce = steps.trim() || null;
			body.expected_behavior = expected.trim() || null;
			body.actual_behavior = actualBehavior.trim() || null;
		} else if (type === 'improvement') {
			body.expected_benefit = benefit.trim() || null;
		}
		try {
			const issue = await api.post<Issue>('/issues', body);
			await goto(`/issues/${issue.id}`);
		} catch (err) {
			error = err instanceof Error ? err.message : 'Could not create the issue';
			toastError(err);
		} finally {
			busy = false;
		}
	}

	function ctrlEnter(e: KeyboardEvent) {
		if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
			(e.currentTarget as HTMLElement).closest('form')?.requestSubmit();
		}
	}
</script>

<PageHeader title="New issue" crumbs={[{ label: 'Issues', href: '/issues' }, { label: 'New' }]} />

<form
	class="grid max-w-5xl grid-cols-1 gap-4 p-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]"
	onsubmit={submit}
>
	<div class="grid grid-cols-1 content-start gap-3">
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
					{#each PRIORITIES as p (p)}
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
			<Textarea id="description" bind:value={description} rows={4} onkeydown={ctrlEnter} />
		</div>

		{#if type === 'non_conformance'}
			<div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
				<div class="grid grid-cols-1 gap-1.5">
					<Label for="should-be">Should be</Label>
					<Textarea id="should-be" bind:value={shouldBe} rows={3} onkeydown={ctrlEnter} />
				</div>
				<div class="grid grid-cols-1 gap-1.5">
					<Label for="actual">Is</Label>
					<Textarea id="actual" bind:value={actual} rows={3} onkeydown={ctrlEnter} />
				</div>
			</div>
		{:else if type === 'bug'}
			<div class="grid grid-cols-1 gap-1.5">
				<Label for="steps">Steps to reproduce</Label>
				<Textarea id="steps" bind:value={steps} rows={3} onkeydown={ctrlEnter} />
			</div>
			<div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
				<div class="grid grid-cols-1 gap-1.5">
					<Label for="expected">Expected behavior</Label>
					<Textarea id="expected" bind:value={expected} rows={2} onkeydown={ctrlEnter} />
				</div>
				<div class="grid grid-cols-1 gap-1.5">
					<Label for="actual-behavior">Actual behavior</Label>
					<Textarea
						id="actual-behavior"
						bind:value={actualBehavior}
						rows={2}
						onkeydown={ctrlEnter}
					/>
				</div>
			</div>
		{:else if type === 'improvement'}
			<div class="grid grid-cols-1 gap-1.5">
				<Label for="benefit">Expected benefit</Label>
				<Textarea id="benefit" bind:value={benefit} rows={2} onkeydown={ctrlEnter} />
			</div>
		{/if}

		{#if error}
			<p
				role="alert"
				class="rounded-md border border-error/40 bg-error-muted px-2 py-1.5 text-xs text-error"
			>
				{error}
			</p>
		{/if}
		<div class="flex gap-2">
			<Button type="submit" disabled={busy || !title.trim()}>CREATE</Button>
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
					{@render link(part, 'part', 'Search parts', (c) => (part = c))}
				</DetailRow>
				<DetailRow label="Execution">
					{@render link(execution, 'execution', 'Search executions', (c) => {
						execution = c;
						// A different execution invalidates its step anchor.
						step = null;
					})}
				</DetailRow>
				{#if !execution || procedure}
					<DetailRow label="Procedure">
						{#if execution}
							{procedure?.label}
						{:else}
							{@render link(procedure, 'procedure', 'Search procedures', (c) => (procedure = c))}
						{/if}
					</DetailRow>
				{/if}
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

{#snippet link(
	current: Ctx | null,
	kind: 'part' | 'procedure' | 'execution',
	placeholder: string,
	set: (c: Ctx | null) => void
)}
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
	{:else}
		<EntityPicker
			{kind}
			{placeholder}
			label={placeholder}
			onpick={(r) => set({ id: r.id, label: r.label, sub: r.sublabel })}
		/>
	{/if}
{/snippet}
