<script lang="ts">
	// The mark that names a callout's kind. WARNING (a person can be hurt) is a reversed ink block
	// with a hazard-stripe tab; CAUTION (hardware) an amber block; INFO a dotted box. The word
	// carries the meaning; the stripe and the amber are extra and may be lost to glare.
	import { cn } from '#lib/utils.js';
	import { CALLOUT_LABEL } from './callouts.js';
	import type { Callout } from './types.js';

	let { kind, class: klass = '' }: { kind: Callout['kind']; class?: string } = $props();
	const word = 'border py-0.5 text-center font-mono text-xs font-bold tracking-wide uppercase';
</script>

{#if kind === 'warning'}
	<span class={cn('grid grid-cols-[0.5rem_minmax(0,1fr)]', klass)}>
		<span class="hazard border border-r-0 border-error-fill" aria-hidden="true"></span>
		<span class={cn(word, 'border-foreground bg-foreground text-background')}
			>{CALLOUT_LABEL.warning}</span
		>
	</span>
{:else}
	<span
		class={cn(
			word,
			kind === 'caution'
				? 'border-warn-fill bg-warn-fill text-warn-on'
				: 'border-dotted border-foreground text-foreground',
			klass
		)}>{CALLOUT_LABEL[kind]}</span
	>
{/if}
