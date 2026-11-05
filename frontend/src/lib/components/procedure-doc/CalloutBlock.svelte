<script lang="ts">
	// One callout, with the step it governs: the label inline with the text, small type, a thin
	// coloured rule. No box. Heavy warnings on every step teach people to skip them.
	import { cn } from '#lib/utils.js';
	import type { Callout } from './types.js';

	let { callout }: { callout: Callout } = $props();
	const caution = $derived(callout.kind === 'caution');
</script>

{#if callout.text}
	<p
		role="note"
		aria-label={caution ? 'Caution' : 'Info'}
		class={cn(
			'm-0 border-l-2 pl-2 text-xs leading-snug whitespace-pre-wrap text-foreground',
			caution ? 'border-l-warn' : 'border-l-info'
		)}
	>
		<span
			class={cn(
				'mr-1.5 font-mono font-semibold tracking-wider uppercase',
				caution ? 'text-warn' : 'text-info'
			)}>{caution ? 'Caution' : 'Info'}</span
		>{callout.text}
	</p>
{/if}
