<script lang="ts">
	// Authored reference imagery: instruction content, lazy-loaded, opens in the
	// lightbox. In author mode each figure carries caption, order and removal,
	// and a picker adds more.
	import { Button } from '#lib/components/ui/button/index.js';
	import { cn } from '#lib/utils.js';
	import { useDoc } from './controller.js';
	import { attachmentUrl, lightbox } from './lightbox.svelte.js';
	import type { DocImage, DocStep } from './types.js';

	let { images, step }: { images: DocImage[]; step?: DocStep } = $props();
	const ctl = useDoc();
	const au = $derived(ctl.mode === 'author' && step ? ctl.author : undefined);
	let picker = $state<HTMLInputElement | null>(null);
	let over = $state(false);

	function add(files: FileList | File[] | null | undefined) {
		if (au && step && files?.length) au.addImages(step, Array.from(files));
	}
</script>

{#if images.length || au}
	<div
		class={cn('grid gap-1.5', over && 'outline outline-1 outline-ring')}
		role="group"
		aria-label="Reference images"
		ondragover={(e) => {
			if (au && e.dataTransfer?.types.includes('Files')) {
				e.preventDefault();
				over = true;
			}
		}}
		ondragleave={() => (over = false)}
		ondrop={(e) => {
			over = false;
			if (au && e.dataTransfer?.files.length) {
				e.preventDefault();
				add(e.dataTransfer.files);
			}
		}}
	>
		{#if au}
			<div class="flex items-center gap-2">
				<span class="label">Images</span>
				<Button size="xs" variant="outline" onclick={() => picker?.click()}>+ IMAGE</Button>
				{#if !images.length}<span class="font-mono text-xs text-muted-foreground"
						>IMAGES — none</span
					>{/if}
				<input
					bind:this={picker}
					type="file"
					accept="image/*"
					multiple
					hidden
					onchange={(e) => {
						add(e.currentTarget.files);
						e.currentTarget.value = '';
					}}
				/>
			</div>
		{/if}
		<div class="flex flex-wrap gap-2">
			{#each images as img (img.id ?? img.attachment_id)}
				<figure class="m-0 grid gap-1" data-image-id={img.id}>
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
					{#if au && step}
						<input
							type="text"
							maxlength={255}
							class="h-6 w-full max-w-56 border border-input bg-transparent px-1.5 font-mono text-[11px] focus:border-ring focus:outline-none"
							placeholder="Caption"
							aria-label="Caption"
							value={img.caption ?? ''}
							onkeydown={(e) => e.stopPropagation()}
							oninput={(e) => au.setCaption(step, img.id!, e.currentTarget.value)}
						/>
						<div class="flex items-center gap-0.5">
							<Button
								size="xs"
								variant="ghost"
								aria-label="Move image earlier"
								onclick={() => au.moveImage(step, img.id!, -1)}>←</Button
							>
							<Button
								size="xs"
								variant="ghost"
								aria-label="Move image later"
								onclick={() => au.moveImage(step, img.id!, 1)}>→</Button
							>
							<Button
								size="xs"
								variant="ghost"
								class="ml-auto"
								aria-label="Remove image"
								onclick={() => au.removeImage(step, img.id!)}>REMOVE</Button
							>
						</div>
					{:else if img.caption}
						<figcaption class="max-w-56 font-mono text-[11px] text-muted-foreground">
							{img.caption}
						</figcaption>
					{/if}
				</figure>
			{/each}
		</div>
	</div>
{/if}
