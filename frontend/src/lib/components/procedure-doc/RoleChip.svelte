<script lang="ts">
	// Required role for an OP or step. Outline chip: a fact, not a state.
	let { role }: { role: string | null | undefined } = $props();
</script>

{#if role}
	<span
		class="inline-flex h-5 items-center border border-border px-1.5 font-mono text-[11px] font-medium tracking-wide whitespace-nowrap text-muted-foreground"
		title="Required role">{role}</span
	>
{/if}
