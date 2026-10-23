<script lang="ts">
	// Everything about one step, in reading order: holds and context, caution,
	// instructions, reference images, parts, data capture, execution notes, sign-offs.
	import { markdown } from '#lib/markdown.js';
	import { stateLabel } from '#lib/format.js';
	import { useDoc } from './controller.js';
	import CautionBlock from './CautionBlock.svelte';
	import StepImages from './StepImages.svelte';
	import StepKit from './StepKit.svelte';
	import CaptureFields from './CaptureFields.svelte';
	import CaptureReadout from './CaptureReadout.svelte';
	import ExecutionNotes from './ExecutionNotes.svelte';
	import SignoffTable from './SignoffTable.svelte';
	import SignoffEditor from './author/SignoffEditor.svelte';
	import CautionEditor from './author/CautionEditor.svelte';
	import MarkdownEditor from './author/MarkdownEditor.svelte';
	import SaveBadge from './author/SaveBadge.svelte';
	import StepProps from './author/StepProps.svelte';
	import type { DocOp, DocStep } from './types.js';

	let { step, op }: { step: DocStep; op: DocOp } = $props();
	const ctl = useDoc();

	const workable = $derived(
		ctl.mode === 'execute' &&
			ctl.active &&
			(step.status === 'pending' || step.status === 'in_progress')
	);
	const authoring = $derived(ctl.mode === 'author');
	const hasFields = $derived((step.data_schema?.fields?.length ?? 0) > 0);
</script>

<div class="grid grid-cols-1 gap-3 px-3 py-3" data-step-body={step.order}>
	{#if step.issue_history.length}
		<div class="font-mono text-xs text-muted-foreground">
			{#each step.issue_history as i, n (i.issue_id)}
				{#if n > 0}<span> · </span>{/if}<a
					class="text-info hover:underline"
					href={`/issues/${i.issue_id}`}>{i.issue_number}</a
				>
				— {stateLabel(i.disposition_type ?? i.state)}
			{/each}
		</div>
	{/if}

	{#if authoring}
		<div class="-mb-1 flex min-h-4 justify-end"><SaveBadge {step} /></div>
		<CautionEditor {step} />
		<MarkdownEditor
			id={`instr-${step.order}`}
			label="Instructions"
			value={step.instructions}
			onchange={(v) => ctl.author?.edit(step, { instructions: v })}
		/>
	{:else}
		<CautionBlock text={step.caution} />

		{#if step.instructions}
			<!-- eslint-disable-next-line svelte/no-at-html-tags -- markdown() sanitizes -->
			<div class="prose-opal max-w-3xl">{@html markdown(step.instructions)}</div>
		{/if}
	{/if}
	<StepImages images={step.images} {step} />
	<StepKit {step} />

	{#if hasFields || authoring}
		{#if workable || authoring}
			<CaptureFields {step} />
		{:else}
			<CaptureReadout {step} />
		{/if}
	{/if}

	{#if step.status === 'skipped' && step.skip_reason}
		<div class="font-mono text-xs text-muted-foreground">
			<span class="label">Skip reason</span>
			{step.skip_reason}
		</div>
	{/if}
	{#if !authoring}
		<ExecutionNotes {step} />
	{/if}

	{#if authoring}
		<SignoffEditor {step} {op} />
	{:else}
		<SignoffTable {step} {op} />
	{/if}

	{#if authoring}
		<StepProps {step} {op} isOp={op.step === step} />
	{/if}
</div>
