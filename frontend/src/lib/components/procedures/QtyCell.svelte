<script lang="ts">
	// Quantity that edits in place: click to edit, Enter or blur saves, Escape cancels.
	import { Input } from '#lib/components/ui/input/index.js';
	import { qty } from '#lib/format.js';

	let {
		value,
		label,
		onsave
	}: { value: number; label: string; onsave: (next: number) => Promise<void> } = $props();

	let editing = $state(false);
	let draft = $state('');
	let busy = $state(false);

	function start() {
		draft = String(value);
		editing = true;
	}

	async function commit() {
		if (!editing || busy) return;
		const next = Number(draft);
		if (!Number.isFinite(next) || next <= 0 || next === value) {
			editing = false;
			return;
		}
		busy = true;
		try {
			await onsave(next);
		} finally {
			busy = false;
			editing = false;
		}
	}

	function focusOnMount(node: HTMLInputElement) {
		node.focus();
		node.select();
	}
</script>

{#if editing}
	<Input
		type="number"
		step="any"
		min="0"
		class="h-6 w-24 px-1.5 text-right font-mono text-xs"
		aria-label={label}
		bind:value={draft}
		disabled={busy}
		onblur={commit}
		onkeydown={(e) => {
			if (e.key === 'Enter') commit();
			if (e.key === 'Escape') editing = false;
		}}
		{@attach focusOnMount}
	/>
{:else}
	<button
		type="button"
		class="font-mono tabular-nums hover:bg-accent hover:underline"
		aria-label={`${label}: ${value}. Edit`}
		onclick={start}>{qty(value)}</button
	>
{/if}
