<script lang="ts">
	// Authored markdown. markdown() sanitizes (DOMPurify) before it reaches {@html}.
	import { cn } from '#lib/utils.js';
	import { markdown } from '#lib/markdown.js';

	let { source, class: className }: { source: string | null | undefined; class?: string } =
		$props();
</script>

<!-- eslint-disable-next-line svelte/no-at-html-tags -->
<div class={cn('prose-opal', className)}>{@html markdown(source)}</div>
