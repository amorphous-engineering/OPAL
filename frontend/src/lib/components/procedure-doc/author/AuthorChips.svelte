<script lang="ts">
	// What a collapsed row holds, as the facts an author needs at a glance:
	// sign-off, estimate, data fields, images, parts.
	import { duration } from '#lib/format.js';
	import type { DocStep } from '../types.js';

	let { step }: { step: DocStep } = $props();
	const fields = $derived(step.data_schema?.fields?.length ?? 0);
	const chip = 'font-mono text-[11px] whitespace-nowrap text-muted-foreground hidden md:inline';
</script>

{#if step.requires_signoff}<span class={chip} title="Requires sign-off">SIGNOFF</span>{/if}
{#if step.estimated_duration_minutes}<span class={chip} title="Estimate"
		>{duration(step.estimated_duration_minutes)}</span
	>{/if}
{#if fields}<span class={chip} title="Data fields">{fields} DATA</span>{/if}
{#if step.images.length}<span class={chip} title="Reference images">{step.images.length} IMG</span
	>{/if}
{#if step.step_kit.length}<span class={chip} title="Step parts">{step.step_kit.length} PARTS</span
	>{/if}
