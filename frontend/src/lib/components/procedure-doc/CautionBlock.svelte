<script lang="ts">
	// Hazard text from the procedure. Always visible with the step it belongs to.
	let { text }: { text: string | null | undefined } = $props();
</script>

{#if text}
	<div role="note" class="border border-error/50 bg-error-muted px-3 py-2 text-xs">
		<div class="label mb-0.5 text-error">Caution</div>
		<div class="whitespace-pre-wrap text-foreground">{text}</div>
	</div>
{/if}
