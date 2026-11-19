<script lang="ts">
	// The number a record will take, shown on its form before it exists, as the new template
	// dialog does. A batch shows its range. Nothing is reserved: leaving the form uses no number,
	// and another create may take it first, so the record's own page has the final word.
	import { opal } from '#lib/api.js';

	let {
		kind,
		count = 1
	}: {
		kind: 'issue' | 'risk' | 'requirement' | 'purchase' | 'workOrder' | 'stock';
		count?: number;
	} = $props();

	let range = $state<{ first: string; last: string } | null>(null);

	$effect(() => {
		const n = Math.max(1, Math.floor(count) || 1);
		const k = kind;
		let cancelled = false;
		const timer = setTimeout(() => {
			opal.org.settings
				.nextNumber({ kind: k, count: n })
				.then((r) => !cancelled && (range = r))
				// A number that cannot be shown is left out; the form works without it.
				.catch(() => !cancelled && (range = null));
		}, 150);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	});
</script>

{#if range}
	<div class="grid grid-cols-1 gap-1.5">
		<span class="label">Number</span>
		<span class="font-mono text-sm" data-next-number
			>{range.first}{#if range.last !== range.first}&ensp;to&ensp;{range.last}{/if}</span
		>
	</div>
{/if}
