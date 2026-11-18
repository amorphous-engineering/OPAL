<script lang="ts">
	// One callout, with the step it governs, at the size of the step's own text. The label is the
	// mark (CalloutLabel). No box around the text: heavy warnings on every step teach people to
	// skip them.
	import CalloutLabel from './CalloutLabel.svelte';
	import { CALLOUT_LABEL } from './callouts.js';
	import type { Callout } from './types.js';

	let { callout }: { callout: Callout } = $props();
</script>

{#if callout.text}
	<p
		role="note"
		aria-label={CALLOUT_LABEL[callout.kind]}
		class="m-0 grid grid-cols-[5.5rem_minmax(0,1fr)] items-start gap-x-2.5 text-step"
	>
		<CalloutLabel kind={callout.kind} class="mt-px" />
		<span class="whitespace-pre-wrap">{callout.text}</span>
	</p>
{/if}
