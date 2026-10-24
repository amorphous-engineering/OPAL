<script lang="ts">
	// Raise an issue (non-conformance) at the moment of discovery. The step,
	// work order and operator are known; the form asks only what was observed.
	import { onMount } from 'svelte';
	import { opal } from '#lib/api.js';
	import { toast, toastError } from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { MarkdownField } from '#lib/components/markdown/index.js';
	import { NativeSelect } from '#lib/components/ui/native-select/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import type { DocStep } from '#lib/components/procedure-doc/index.js';
	import type { ExecutionStore } from '#lib/execution/store.svelte.js';
	import FormRow from './FormRow.svelte';

	let { store, step }: { store: ExecutionStore; step: DocStep } = $props();

	let title = $state('');
	let shouldBe = $state('');
	let actual = $state('');
	let description = $state('');
	let priority = $state<'low' | 'medium' | 'high' | 'critical'>('medium');
	let containment = $state<'advisory' | 'step' | 'op' | 'wo'>('step');
	let boundary = $state('');
	let assignee = $state('');
	let files = $state<FileList | undefined>();
	let busy = $state(false);
	let error = $state<string | null>(null);
	let people = $state<{ id: number; name: string }[]>([]);

	onMount(async () => {
		try {
			people = await opal.issues.assignees({});
		} catch {
			/* assignment is optional */
		}
	});

	// Steps that can still be held: the boundary ("resolve by") may be a later step.
	const candidates = $derived(
		store.allOps.flatMap((op) =>
			(op.steps.length ? op.steps : [op.step])
				.filter((s) => s.status === 'pending' || s.status === 'in_progress')
				.map((s) => ({ order: s.order, label: `${s.number} ${s.title}` }))
		)
	);

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		error = null;
		try {
			const issue = await store.raiseIssue(
				step,
				{
					title: title.trim(),
					description: description.trim() || null,
					priority,
					shouldBe: shouldBe.trim() || null,
					actual: actual.trim() || null,
					containment,
					containmentStepId: boundary ? Number(boundary) : null,
					assignedToId: assignee ? Number(assignee) : null
				},
				Array.from(files ?? [])
			);
			store.closeDialog();
			toast.success(`${issue.issueNumber} raised at ${step.number}`, {
				action: { label: 'OPEN', onClick: () => (window.location.href = `/issues/${issue.id}`) }
			});
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to raise issue';
			toastError(err);
		} finally {
			busy = false;
		}
	}
</script>

<form class="grid grid-cols-1 gap-3" onsubmit={submit}>
	<Dialog.Header>
		<Dialog.Title>Raise issue</Dialog.Title>
		<Dialog.Description>
			Raised at <span class="font-mono text-foreground">{step.number}</span>
			{step.title}
		</Dialog.Description>
	</Dialog.Header>
	<FormRow label="Title" for="ri-title" required>
		<Input id="ri-title" bind:value={title} maxlength={255} required autofocus />
	</FormRow>
	<div class="grid grid-cols-2 gap-3">
		<FormRow label="Should be" for="ri-should"
			><Input id="ri-should" bind:value={shouldBe} /></FormRow
		>
		<FormRow label="Is" for="ri-is"><Input id="ri-is" bind:value={actual} /></FormRow>
	</div>
	<FormRow label="Description" for="ri-desc">
		<MarkdownField id="ri-desc" minRows={2} bind:value={description} />
	</FormRow>
	<div class="grid grid-cols-2 gap-3">
		<FormRow label="Priority" for="ri-priority">
			<NativeSelect id="ri-priority" class="w-full" bind:value={priority}>
				<option value="low">LOW</option>
				<option value="medium">MEDIUM</option>
				<option value="high">HIGH</option>
				<option value="critical">CRITICAL</option>
			</NativeSelect>
		</FormRow>
		<FormRow label="Containment" for="ri-containment">
			<NativeSelect id="ri-containment" class="w-full" bind:value={containment}>
				<option value="step">STEP: holds COMPLETE of {step.number}</option>
				<option value="op">OP: holds COMPLETE of the operation</option>
				<option value="wo">WO: holds work order close-out</option>
				<option value="advisory">ADVISORY: holds nothing</option>
			</NativeSelect>
		</FormRow>
	</div>
	{#if containment === 'step'}
		<FormRow label="Resolve by" for="ri-boundary">
			<NativeSelect id="ri-boundary" class="w-full" bind:value={boundary}>
				<option value="">{step.number}, this step</option>
				{#each candidates.filter((c) => c.order !== step.order) as c (c.order)}
					<option value={String(c.order)}>{c.label}</option>
				{/each}
			</NativeSelect>
		</FormRow>
	{/if}
	<div class="grid grid-cols-2 gap-3">
		<FormRow label="Evidence" for="ri-files">
			<Input id="ri-files" type="file" accept="image/*" capture="environment" multiple bind:files />
		</FormRow>
		<FormRow label="Assign" for="ri-assign">
			<NativeSelect id="ri-assign" class="w-full" bind:value={assignee}>
				<option value="">—</option>
				{#each people as p (p.id)}<option value={String(p.id)}>{p.name}</option>{/each}
			</NativeSelect>
		</FormRow>
	</div>
	{#if error}<p role="alert" class="text-xs text-error">{error}</p>{/if}
	<Dialog.Footer>
		<Button variant="outline" onclick={() => store.closeDialog()}>CANCEL</Button>
		<Button type="submit" disabled={busy || !title.trim()}>RAISE</Button>
	</Dialog.Footer>
</form>
