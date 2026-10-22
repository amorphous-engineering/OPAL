<script lang="ts">
	// ISO 8601 timestamp; `relative` only for dense index rows (full value in title).
	import { age, datetime, date, iso } from '#lib/format.js';

	let {
		value,
		relative = false,
		dateOnly = false
	}: { value: string | null | undefined; relative?: boolean; dateOnly?: boolean } = $props();
</script>

{#if !value}
	<span class="text-muted-foreground">—</span>
{:else}
	<time class="font-mono text-xs tabular-nums" datetime={iso(value)} title={iso(value)}
		>{relative ? age(value) : dateOnly ? date(value) : datetime(value)}</time
	>
{/if}
