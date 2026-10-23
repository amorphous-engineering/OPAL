<script lang="ts">
	// Hazard text from the procedure, always visible with the step it belongs to.
	// The original OPAL look: an alert box with a heavy red rule on the left and a
	// red CAUTION heading; the hazard itself reads exactly like the instructions around it.
	let { text }: { text: string | null | undefined } = $props();
</script>

{#if text}
	<div
		role="note"
		aria-label="Caution"
		class="grid gap-1 border border-l-[3px] border-error/40 border-l-error bg-card px-4 py-3"
	>
		<div class="font-mono text-sm font-semibold tracking-wider text-error uppercase">Caution</div>
		<div class="text-sm leading-relaxed whitespace-pre-wrap text-foreground">{text}</div>
	</div>
{/if}
