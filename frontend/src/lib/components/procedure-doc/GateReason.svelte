<script lang="ts">
	// Why a control is inert. Names the first blocker and counts the rest; the
	// full list rides in the tooltip. Issue-backed blockers link to the issue.
	import type { DocBlocker } from './types.js';

	let { blockers }: { blockers: DocBlocker[] } = $props();

	const first = $derived(blockers[0]);
	const parts = $derived(first && !first.issue_number ? first.message.split(', ') : []);
	const extra = $derived(
		first?.issue_number ? blockers.length - 1 : parts.length - 1 + (blockers.length - 1)
	);
	const full = $derived(
		blockers.map((b) => (b.issue_number ? `held by ${b.issue_number}` : b.message)).join('; ')
	);
</script>

{#if first}
	<span class="font-mono text-[11px] text-warn" title={full}>
		{#if first.issue_number}
			held by <a class="underline" href={`/issues/${first.issue_id}`}>{first.issue_number}</a>
		{:else}
			{parts[0]}
		{/if}
		{#if extra > 0}+{extra}{/if}
	</span>
{/if}
