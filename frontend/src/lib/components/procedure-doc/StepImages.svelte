<script lang="ts">
	// Authored reference imagery: instruction content, lazy-loaded, opens in the lightbox.
	import { attachmentUrl, lightbox } from './lightbox.svelte.js';
	import type { DocImage } from './types.js';

	let { images }: { images: DocImage[] } = $props();
</script>

{#if images.length}
	<div class="flex flex-wrap gap-2">
		{#each images as img (img.attachment_id)}
			<figure class="m-0 grid gap-1">
				<button
					type="button"
					class="block border border-border bg-muted focus-visible:ring-1 focus-visible:ring-ring"
					onclick={() => lightbox.open(attachmentUrl(img.attachment_id), img.caption)}
					aria-label={img.caption ? `Enlarge: ${img.caption}` : 'Enlarge reference image'}
				>
					<img
						loading="lazy"
						decoding="async"
						src={attachmentUrl(img.attachment_id)}
						alt={img.caption ?? 'Reference image'}
						class="h-28 w-auto max-w-56 object-contain"
					/>
				</button>
				{#if img.caption}
					<figcaption class="max-w-56 font-mono text-[11px] text-muted-foreground">
						{img.caption}
					</figcaption>
				{/if}
			</figure>
		{/each}
	</div>
{/if}
