<script lang="ts">
	// State text in state colour. Badge form only where the state is exceptional
	// or actionable (register rule 2); plain text otherwise.
	import { cn } from '#lib/utils.js';
	import { stateLabel } from '#lib/format.js';
	import { toneBox, toneFor, toneText, type Tone } from './tone.js';

	let {
		value,
		tone,
		badge = false,
		label,
		class: className
	}: {
		value: string | null | undefined;
		tone?: Tone;
		badge?: boolean;
		label?: string;
		class?: string;
	} = $props();

	const draft = $derived(value?.toLowerCase() === 'draft');
	const t = $derived(draft ? 'draft' : (tone ?? toneFor(value)));
	const text = $derived(label ?? stateLabel(value));
</script>

{#if badge}
	<span
		class={cn(
			'inline-flex h-5 items-center border px-1.5 font-mono text-xs font-medium tracking-wide whitespace-nowrap',
			toneBox[t],
			draft && 'border-dashed border-tan px-1.5',
			className
		)}>{text}</span
	>
{:else}
	<span
		class={cn(
			'font-mono text-xs font-medium tracking-wide whitespace-nowrap',
			toneText[t],
			className
		)}>{text}</span
	>
{/if}
