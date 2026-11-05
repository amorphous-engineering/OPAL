<script lang="ts">
	// Execution notes: a record of what happened at this step. Markdown body, images as
	// thumbnails that open the viewer, other files as links. Present in every status, including
	// finished work orders. The box is always open while the step takes notes. What is typed stays
	// with the controller until ADD, or until the step is completed or skipped, which saves it too.
	import XIcon from 'phosphor-svelte/lib/X';
	import { Avatar, EmptyLine, Section, Timestamp } from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { markdown } from '#lib/markdown.js';
	import { useDoc } from './controller.js';
	import { fileSize } from './files.js';
	import type { DocStep } from './types.js';
	import { attachmentUrl, gallery } from './viewer.js';

	let { step }: { step: DocStep } = $props();
	const ctl = useDoc();
	const draft = $derived(ctl.actions.addNote && !ctl.struck ? ctl.noteDraft : undefined);
	const body = $derived(draft?.body(step) ?? '');
	const files = $derived(draft?.files(step) ?? []);
	const filled = $derived(!!body.trim() || files.length > 0);
	const boxId = $derived(`note-box-${step.order}`);

	let busy = $state(false);
	let picker = $state<HTMLInputElement | null>(null);

	async function add(e?: Event) {
		e?.preventDefault();
		if (!draft || busy || !filled) return;
		busy = true;
		try {
			await draft.save(step);
		} finally {
			busy = false;
		}
	}

	function attach(list: Iterable<File> | null) {
		if (list) draft?.setFiles(step, [...files, ...list]);
	}
</script>

{#snippet box(labelled: boolean)}
	{#if draft}
		<form
			class={labelled
				? 'grid grid-cols-[5.5rem_minmax(0,1fr)] items-start gap-x-2.5'
				: 'border-t border-dotted px-3 py-1.5'}
			onsubmit={add}
		>
			{#if labelled}<label class="label pt-1.5 text-foreground" for={boxId}>Notes</label>{/if}
			<div class="grid grid-cols-1 gap-1">
				<div class="flex items-start gap-1.5">
					<Textarea
						id={boxId}
						aria-label={labelled ? undefined : 'Execution note'}
						rows={1}
						class="min-h-7 flex-1 py-1"
						value={body}
						oninput={(e) => draft.setBody(step, e.currentTarget.value)}
						onkeydown={(e) => {
							if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void add(e);
						}}
						onpaste={(e) => {
							const pasted = Array.from(e.clipboardData?.files ?? []);
							if (pasted.length) {
								e.preventDefault();
								attach(pasted);
							}
						}}
					/>
					{#if filled}<Button type="submit" class="px-3" disabled={busy}>ADD</Button>{/if}
					<Button variant="outline" class="px-3" onclick={() => picker?.click()}>+ FILE</Button>
					<input
						bind:this={picker}
						type="file"
						multiple
						hidden
						onchange={(e) => {
							attach(e.currentTarget.files);
							e.currentTarget.value = '';
						}}
					/>
				</div>
				{#if files.length}
					<ul class="grid grid-cols-1 border border-dashed border-foreground font-mono text-xs">
						{#each files as f, i (f.name + i)}
							<li
								class="flex items-center gap-2 border-b border-dotted px-2 py-0.5 last:border-b-0"
							>
								<span class="min-w-0 flex-1 truncate">{f.name}</span>
								<span class="text-muted-foreground">{fileSize(f.size)}</span>
								<Button
									size="icon-xs"
									variant="ghost"
									aria-label={`Remove ${f.name}`}
									onclick={() =>
										draft.setFiles(
											step,
											files.filter((_, j) => j !== i)
										)}><XIcon /></Button
								>
							</li>
						{/each}
					</ul>
				{/if}
			</div>
		</form>
	{/if}
{/snippet}

<div class="grid grid-cols-1 gap-1.5" data-notes>
	{#if step.notes.length}
		<Section title="Execution notes" count={step.notes.length}>
			<div class="grid grid-cols-1">
				{#each step.notes as n (n.id)}
					{@const files = n.attachments ?? []}
					{@const images = files.filter((f) => f.is_image)}
					{@const others = files.filter((f) => !f.is_image)}
					<article
						class="grid grid-cols-1 gap-1.5 border-b border-dotted px-3 py-2 last:border-b-0"
					>
						<header class="flex items-baseline justify-between gap-3">
							<span class="inline-flex items-center gap-2">
								{#if n.author}<Avatar user={n.author} size="xs" />{/if}
								<span class="text-xs font-semibold">{n.author?.name ?? '—'}</span>
							</span>
							<Timestamp value={n.created_at} />
						</header>
						<!-- eslint-disable-next-line svelte/no-at-html-tags -->
						{#if n.body}<div class="prose-opal">{@html markdown(n.body)}</div>{/if}
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
			{@render box(false)}
		</Section>
	{/if}
	{#if draft && !step.notes.length}
		{@render box(true)}
	{:else if !draft && !step.notes.length}
		<EmptyLine label="Execution notes" />
	{/if}
</div>
