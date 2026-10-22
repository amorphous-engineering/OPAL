<script lang="ts">
	// Autosave state of one step, in words: saving / unsaved / saved / error + retry.
	import { cn } from '#lib/utils.js';
	import { useDoc } from '../controller.js';
	import type { DocStep } from '../types.js';

	let { step, quiet = false }: { step: DocStep; quiet?: boolean } = $props();
	const au = useDoc().author!;
	const state = $derived(au.stepState(step));
	const message = $derived(au.stepError(step));
</script>

{#if state === 'error'}
	<span class="inline-flex items-center gap-1.5 font-mono text-[11px] text-error" role="alert">
		<span class="max-w-64 truncate" title={message ?? ''}
			>NOT SAVED{message ? ` · ${message}` : ''}</span
		>
		<button
			type="button"
			class="underline"
			onclick={(e) => {
				e.stopPropagation();
				au.retry();
			}}>RETRY</button
		>
	</span>
{:else if state === 'saving' || state === 'dirty'}
	<span class="font-mono text-[11px] text-warn" aria-live="polite"
		>{state === 'saving' ? 'SAVING' : 'UNSAVED'}</span
	>
{:else if state === 'saved' && !quiet}
	<span class={cn('font-mono text-[11px] text-muted-foreground')} aria-live="polite">SAVED</span>
{/if}
