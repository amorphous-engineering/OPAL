<script lang="ts">
	// One callout, with the step it governs, at the size of the step's own text. The label is the
	// mark: an amber block for a caution, a dotted box for info. No box around the text: heavy
	// warnings on every step teach people to skip them.
	import { cn } from '#lib/utils.js';
	import type { Callout } from './types.js';

	let { callout }: { callout: Callout } = $props();
	const caution = $derived(callout.kind === 'caution');
</script>

{#if callout.text}
	<p
		role="note"
		aria-label={caution ? 'Caution' : 'Info'}
		class="m-0 grid grid-cols-[5.5rem_minmax(0,1fr)] items-start gap-x-2.5 text-step"
	>
		<span
			class={cn(
				'mt-px border py-0.5 text-center font-mono text-xs font-bold tracking-wide uppercase',
				caution
					? 'border-warn-fill bg-warn-fill text-warn-on'
					: 'border-dotted border-foreground text-foreground'
			)}>{caution ? 'Caution' : 'Info'}</span
		>
		<span class="whitespace-pre-wrap">{callout.text}</span>
	</p>
{/if}
