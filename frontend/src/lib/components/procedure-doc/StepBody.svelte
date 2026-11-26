<script lang="ts">
	// Everything about one step, in reading order: holds and context, callouts,
	// instructions, reference images, parts, data capture, execution notes, sign-offs.
	import { markdown } from '#lib/markdown.js';
	import { stateLabel } from '#lib/format.js';
	import { useDoc } from './controller.js';
	import CalloutList from './CalloutList.svelte';
	import StepImages from './StepImages.svelte';
	import StepKit from './StepKit.svelte';
	import CaptureFields from './CaptureFields.svelte';
	import CaptureReadout from './CaptureReadout.svelte';
	import ExecutionNotes from './ExecutionNotes.svelte';
	import SignoffTable from './SignoffTable.svelte';
	import StepActions from './StepActions.svelte';
	import AuthorBody from './author/AuthorBody.svelte';
	import { isRoutine, type DocOp, type DocStep } from './types.js';
	import StepUnits from '#lib/components/units/StepUnits.svelte';

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

{#if authoring}
	<div class="px-3 py-2" data-step-body={step.order}><AuthorBody {step} {op} /></div>
{:else}
	<div class="grid grid-cols-1 gap-2 px-3 py-2" data-step-body={step.order}>
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

		<CalloutList callouts={step.callouts ?? []} />

		{#if step.instructions}
			<div class="prose-opal max-w-3xl text-step leading-normal">
				<!-- eslint-disable-next-line svelte/no-at-html-tags -- markdown() sanitizes -->
				{@html markdown(step.instructions)}
			</div>
		{/if}
		<StepImages images={step.images} {step} />
		<StepUnits {step} {op} />
		<StepKit {step} />

		{#if hasFields}
			{#if workable}
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
		<ExecutionNotes {step} />

		{#if !isRoutine(step, op)}
			<SignoffTable {step} {op} />
		{/if}
		<StepActions {step} {op} />
	</div>
{/if}
