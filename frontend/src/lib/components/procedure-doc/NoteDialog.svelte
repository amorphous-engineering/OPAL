<script lang="ts">
	// New execution note: markdown textarea with the markdown-toolbar element (inserts
	// syntax only, not WYSIWYG) and files that upload with the note.
	import { onMount } from 'svelte';
	import XIcon from 'phosphor-svelte/lib/X';
	import { confirm } from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { useDoc } from './controller.js';
	import { fileSize } from './files.js';
	import type { DocStep } from './types.js';

	let { step, open = $bindable(false) }: { step: DocStep; open: boolean } = $props();
	const ctl = useDoc();

	const uid = $props.id();
	const bodyId = `note-body-${uid}`;
	let body = $state('');
	let files = $state<File[]>([]);
	let busy = $state(false);
	let area = $state<HTMLTextAreaElement | null>(null);
	let picker = $state<HTMLInputElement | null>(null);

	const empty = $derived(!body.trim() && files.length === 0);

	onMount(() => {
		// Custom elements: register client-side only.
		void import('@github/markdown-toolbar-element');
	});

	function reset() {
		body = '';
		files = [];
	}

	async function discard() {
		if (busy) return;
		if (
			!empty &&
			!(await confirm({
				title: 'Discard note?',
				body: 'The text and chosen files are dropped.',
				action: 'DISCARD',
				destructive: true
			}))
		)
			return;
		reset();
		open = false;
	}

	async function save() {
		if (empty || busy || !ctl.actions.addNote) return;
		busy = true;
		try {
			if (await ctl.actions.addNote(step, body.trim(), files)) {
				reset();
				open = false;
			}
		} finally {
			busy = false;
		}
	}

	function underline() {
		if (!area) return;
		const { selectionStart: a, selectionEnd: b } = area;
		const picked = area.value.slice(a, b);
		area.setRangeText(`<u>${picked}</u>`, a, b, 'end');
		if (!picked) area.setSelectionRange(a + 3, a + 3);
		area.dispatchEvent(new Event('input', { bubbles: true }));
		area.focus();
	}

	function addFiles(list: FileList | null) {
		if (list) files = [...files, ...Array.from(list)];
	}

	const tool =
		'inline-flex h-6 min-w-6 cursor-pointer items-center justify-center border border-border bg-background px-1.5 font-mono text-xs select-none hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring';
</script>

<Dialog.Root
	{open}
	onOpenChange={(v) => {
		if (!v) void discard();
	}}
>
	<Dialog.Content class="sm:max-w-2xl" showCloseButton={false}>
		<div class="flex items-center gap-2">
			<Dialog.Title class="mr-auto">New execution note</Dialog.Title>
			<Button size="xs" onclick={save} disabled={empty || busy}>SAVE</Button>
			<Button size="xs" variant="outline" onclick={discard} disabled={busy}>DISCARD</Button>
		</div>
		<Dialog.Description class="sr-only">Markdown note with optional files</Dialog.Description>
		<div class="grid gap-2">
			<markdown-toolbar for={bodyId} class="flex flex-wrap items-center gap-1">
				<md-bold class={tool} title="Bold" aria-label="Bold"><b>B</b></md-bold>
				<md-italic class={tool} title="Italic" aria-label="Italic"><i>I</i></md-italic>
				<button
					type="button"
					class={tool}
					title="Underline"
					aria-label="Underline"
					onclick={underline}><u>U</u></button
				>
				<md-strikethrough class={tool} title="Strikethrough" aria-label="Strikethrough"
					><s>S</s></md-strikethrough
				>
				<md-header level="1" class={tool} title="Heading 1" aria-label="Heading 1">H1</md-header>
				<md-header level="2" class={tool} title="Heading 2" aria-label="Heading 2">H2</md-header>
				<span class="mx-0.5 h-4 w-px bg-border"></span>
				<md-quote class={tool} title="Quote" aria-label="Quote">&gt;</md-quote>
				<span class="mx-0.5 h-4 w-px bg-border"></span>
				<md-unordered-list class={tool} title="Bulleted list" aria-label="Bulleted list"
					>- list</md-unordered-list
				>
				<md-ordered-list class={tool} title="Numbered list" aria-label="Numbered list"
					>1. list</md-ordered-list
				>
				<span class="mx-0.5 h-4 w-px bg-border"></span>
				<md-link class={tool} title="Link" aria-label="Link">link</md-link>
				<md-code class={tool} title="Code" aria-label="Code">&lt;/&gt;</md-code>
				<Button size="xs" variant="outline" class="ml-auto" onclick={() => picker?.click()}
					>+ ADD FILES</Button
				>
				<input
					bind:this={picker}
					type="file"
					multiple
					hidden
					data-note-files
					onchange={(e) => {
						addFiles(e.currentTarget.files);
						e.currentTarget.value = '';
					}}
				/>
			</markdown-toolbar>
			<Textarea
				id={bodyId}
				bind:ref={area}
				bind:value={body}
				rows={8}
				class="max-h-[50vh] font-mono"
				aria-label="Note"
				onkeydown={(e) => {
					if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
						e.preventDefault();
						void save();
					}
				}}
			/>
			{#if files.length}
				<ul class="grid border border-border font-mono text-xs">
					{#each files as f, i (f.name + i)}
						<li class="flex items-center gap-2 border-b border-border px-2 py-1 last:border-b-0">
							<span class="min-w-0 flex-1 truncate">{f.name}</span>
							<span class="text-muted-foreground">{fileSize(f.size)}</span>
							<Button
								size="icon-xs"
								variant="ghost"
								aria-label={`Remove ${f.name}`}
								onclick={() => (files = files.filter((_, j) => j !== i))}><XIcon /></Button
							>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	</Dialog.Content>
</Dialog.Root>
