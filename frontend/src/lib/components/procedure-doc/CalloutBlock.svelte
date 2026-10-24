<script lang="ts">
	// One callout from the procedure, always visible with the step it belongs to.
	// CAUTION: heavy red rule on the left, red heading. INFO: the same shape in the info colour.
	import { cn } from '#lib/utils.js';
	import type { Callout } from './types.js';

	let { callout }: { callout: Callout } = $props();
	const caution = $derived(callout.kind === 'caution');
</script>

{#if callout.text}
	<div
		role="note"
		aria-label={caution ? 'Caution' : 'Info'}
		class={cn(
			'grid grid-cols-1 gap-1 rounded-lg border border-l-[3px] bg-card px-4 py-3',
			caution ? 'border-error/40 border-l-error' : 'border-info/40 border-l-info'
		)}
	>
		<div
			class={cn(
				'font-mono text-sm font-semibold tracking-wider uppercase',
				caution ? 'text-error' : 'text-info'
			)}
		>
			{caution ? 'Caution' : 'Info'}
		</div>
		<div class="text-sm leading-relaxed whitespace-pre-wrap text-foreground">{callout.text}</div>
	</div>
{/if}
