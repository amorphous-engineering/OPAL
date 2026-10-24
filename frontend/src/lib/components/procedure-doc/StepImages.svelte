<script lang="ts">
	// Authored reference imagery: instruction content, lazy-loaded, opens in the image
	// viewer. A carousel shows three uniform 4:3 plates at a time (the image fills them, cover)
	// and pages by three; the viewer shows the whole image. In author mode each figure carries
	// caption, order and removal, and a picker adds more.
	import { Input } from '#lib/components/ui/input/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Carousel from '#lib/components/ui/carousel/index.js';
	import type { CarouselAPI } from '#lib/components/ui/carousel/context.js';
	import { cn } from '#lib/utils.js';
	import { useDoc } from './controller.js';
	import { attachmentUrl, gallery } from './viewer.js';
	import type { DocImage, DocStep } from './types.js';

	const imageUrl = (img: { attachment_id: number; sha256?: string }) =>
		img.sha256 ? `/api/blobs/${img.sha256}` : attachmentUrl(img.attachment_id);

	let { images, step }: { images: DocImage[]; step?: DocStep } = $props();
	const ctl = useDoc();
	const au = $derived(ctl.mode === 'author' && step ? ctl.author : undefined);
	let picker = $state<HTMLInputElement | null>(null);
	let over = $state(false);

	const PER_VIEW = 3;
	let api = $state<CarouselAPI>();
	let inView = $state<number[]>([]);
	let canPrev = $state(false);
	let canNext = $state(false);
	$effect(() => {
		const a = api;
		if (!a) return;
		const update = () => {
			inView = a.slidesInView();
			canPrev = a.canScrollPrev();
			canNext = a.canScrollNext();
		};
		a.on('slidesInView', update).on('select', update).on('reInit', update);
		update();
		return () => void a.off('slidesInView', update).off('select', update).off('reInit', update);
	});
	const paged = $derived(images.length > PER_VIEW);
	const range = $derived(
		inView.length ? `${Math.min(...inView) + 1}–${Math.max(...inView) + 1}` : `1–${PER_VIEW}`
	);

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
		{#if au || paged}
			<div class="flex max-w-3xl items-center gap-2">
				{#if au}
					<span class="label">Images</span>
					<Button size="xs" variant="outline" onclick={() => picker?.click()}>+ IMAGE</Button>
					{#if !images.length}<span class="font-mono text-xs text-muted-foreground">none</span>{/if}
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
				{/if}
				{#if paged}
					<span class="ml-auto font-mono text-xs text-muted-foreground tabular-nums"
						>{range} of {images.length}</span
					>
					<Button
						size="icon-xs"
						variant="outline"
						aria-label="Previous images"
						disabled={!canPrev}
						onclick={() => api?.scrollPrev()}>←</Button
					>
					<Button
						size="icon-xs"
						variant="outline"
						aria-label="Next images"
						disabled={!canNext}
						onclick={() => api?.scrollNext()}>→</Button
					>
				{/if}
			</div>
		{/if}
		<div class="max-w-3xl" use:gallery>
			<Carousel.Root
				opts={{
					align: 'start',
					slidesToScroll: PER_VIEW,
					containScroll: 'trimSnaps',
					inViewThreshold: 0.5
				}}
				setApi={(a) => (api = a)}
			>
				<Carousel.Content class="-ms-2">
					{#each images as img (img.id ?? img.attachment_id)}
						<Carousel.Item class="basis-1/3 ps-2">
							<figure class="m-0 grid grid-cols-1 gap-1" data-image-id={img.id}>
								<a
									data-pswp
									href={imageUrl(img)}
									data-pswp-caption={img.caption ?? ''}
									class="block aspect-[4/3] w-full overflow-hidden rounded-md border border-border bg-muted focus-visible:ring-1 focus-visible:ring-ring"
									aria-label={img.caption ? `Enlarge: ${img.caption}` : 'Enlarge reference image'}
								>
									<img
										loading="lazy"
										decoding="async"
										src={imageUrl(img)}
										alt={img.caption ?? 'Reference image'}
										class="size-full object-cover"
									/>
								</a>
								{#if au && step}
									<Input
										type="text"
										maxlength={255}
										class="h-6 px-1.5 font-mono text-xs"
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
									<figcaption class="font-mono text-xs text-muted-foreground">
										{img.caption}
									</figcaption>
								{/if}
							</figure>
						</Carousel.Item>
					{/each}
				</Carousel.Content>
			</Carousel.Root>
		</div>
	</div>
{/if}
