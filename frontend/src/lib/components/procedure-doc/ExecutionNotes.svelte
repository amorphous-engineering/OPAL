<script lang="ts">
	// Execution notes: a record of what happened at this step. Markdown body, images as
	// thumbnails that open the viewer, other files as links. Present in every status,
	// including finished work orders; `+ ADD` whenever the host offers `addNote`.
	import { Avatar, EmptyLine, Section, Timestamp } from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { markdown } from '#lib/markdown.js';
	import { useDoc } from './controller.js';
	import { fileSize } from './files.js';
	import NoteDialog from './NoteDialog.svelte';
	import type { DocStep } from './types.js';
	import { attachmentUrl, gallery } from './viewer.js';

	let { step }: { step: DocStep } = $props();
	const ctl = useDoc();
	const canAdd = $derived(!!ctl.actions.addNote);
	let open = $state(false);
</script>

<div data-notes>
	{#if step.notes.length}
		<Section title="Execution notes" count={step.notes.length}>
			{#snippet actions()}
				{#if canAdd}
					<Button size="xs" variant="ghost" onclick={() => (open = true)}>+ ADD</Button>
				{/if}
			{/snippet}
			<div class="grid grid-cols-1">
				{#each step.notes as n (n.id)}
					{@const files = n.attachments ?? []}
					{@const images = files.filter((f) => f.is_image)}
					{@const others = files.filter((f) => !f.is_image)}
					<article
						class="grid grid-cols-1 gap-1.5 border-b border-border px-3 py-2 last:border-b-0"
					>
						<header class="flex items-baseline justify-between gap-3">
							<span class="inline-flex items-center gap-2">
								{#if n.author}<Avatar user={n.author} size="xs" />{/if}
								<span class="text-xs font-semibold">{n.author?.name ?? '—'}</span>
							</span>
							<Timestamp value={n.created_at} />
						</header>
						<!-- eslint-disable-next-line svelte/no-at-html-tags -->
						{#if n.body}<div class="prose-opal text-xs">{@html markdown(n.body)}</div>{/if}
						{#if images.length}
							<div class="flex flex-wrap gap-2" use:gallery>
								{#each images as f (f.id)}
									<a
										data-pswp
										href={attachmentUrl(f.id)}
										data-pswp-caption={f.filename}
										class="block rounded-md border border-border"
										aria-label={`Enlarge ${f.filename}`}
									>
										<img
											loading="lazy"
											src={attachmentUrl(f.id)}
											alt={f.filename}
											class="h-20 w-auto max-w-40 object-cover"
										/>
									</a>
								{/each}
							</div>
						{/if}
						{#if others.length}
							<ul class="grid grid-cols-1 gap-0.5 font-mono text-xs">
								{#each others as f (f.id)}
									<li>
										<a
											class="text-info hover:underline"
											href={attachmentUrl(f.id)}
											target="_blank"
											rel="noopener">{f.filename}</a
										>
										<span class="text-muted-foreground">{fileSize(f.size_bytes)}</span>
									</li>
								{/each}
							</ul>
						{/if}
					</article>
				{/each}
			</div>
		</Section>
	{:else}
		<EmptyLine label="Execution notes" onadd={canAdd ? () => (open = true) : undefined} />
	{/if}
</div>

{#if canAdd}<NoteDialog {step} bind:open />{/if}
