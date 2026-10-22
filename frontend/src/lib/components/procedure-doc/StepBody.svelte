<script lang="ts">
	// Everything about one step, in reading order: holds and context, caution,
	// instructions, reference images, parts, data capture, notes, actions.
	import { markdown } from '#lib/markdown.js';
	import { datetime, iso } from '#lib/format.js';
	import { stateLabel } from '#lib/format.js';
	import { useDoc } from './controller.js';
	import CautionBlock from './CautionBlock.svelte';
	import StepImages from './StepImages.svelte';
	import StepKit from './StepKit.svelte';
	import CaptureFields from './CaptureFields.svelte';
	import CaptureReadout from './CaptureReadout.svelte';
	import StepNotes from './StepNotes.svelte';
	import StepActions from './StepActions.svelte';
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
	const raised = $derived(step.holds.filter((h) => h.disposition_state === 'undispositioned'));
	const hasFields = $derived((step.data_schema?.fields?.length ?? 0) > 0);
</script>

<div class="grid gap-3 px-3 py-3" data-step-body={step.order}>
	{#if raised.length}
		<div class="border border-warn/50 bg-warn-muted px-3 py-2 text-xs" role="status">
			<span class="label text-warn">Held by</span>
			{#each raised as h, i (h.issue_id)}
				{#if i > 0}<span class="text-muted-foreground">, </span>{/if}
				<a class="font-mono text-info hover:underline" href={`/issues/${h.issue_id}`}
					>{h.issue_number}</a
				>
				<span class="text-muted-foreground">{h.title}</span>
			{/each}
			<span class="text-muted-foreground">— undispositioned</span>
		</div>
	{/if}
	{#if step.issue_history.length}
		<div class="font-mono text-[11px] text-muted-foreground">
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
	{#if step.signed_off}
		<div class="font-mono text-xs text-muted-foreground">
			<span class="label">Signed off</span>
			{step.signed_off.by ?? '—'}
			<time datetime={iso(step.signed_off.at)} title={iso(step.signed_off.at)}
				>{datetime(step.signed_off.at)}</time
			>
		</div>
	{/if}

	<StepNotes {step} />

	{#if ctl.mode === 'execute'}
		<StepActions {step} {op} />
	{/if}
	{#if authoring}
		<StepProps {step} {op} isOp={op.step === step} />
	{/if}
</div>
