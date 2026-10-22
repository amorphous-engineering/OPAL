<script lang="ts">
	// Word-level diff: struck old text, highlighted new text.
	import type { Segment } from './types.js';

	let { segments }: { segments: Segment[] } = $props();
</script>

<span class="font-mono text-xs whitespace-pre-wrap"
	>{#each segments as s, i (i)}{#if s.op === 'delete'}<del
				class="bg-error-muted text-error line-through">{s.text}</del
			>{:else if s.op === 'insert'}<ins class="bg-ok-muted text-ok no-underline">{s.text}</ins
			>{:else}{s.text}{/if}{/each}</span
>
