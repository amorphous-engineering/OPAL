<script lang="ts">
	// New execution note: the shared markdown editor and files that upload with the note.
	import XIcon from 'phosphor-svelte/lib/X';
	import { confirm } from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import * as Toolbar from '#lib/components/ui/toolbar/index.js';
	import { MarkdownField } from '#lib/components/markdown/index.js';
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
	let picker = $state<HTMLInputElement | null>(null);

	const empty = $derived(!body.trim() && files.length === 0);

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

	function addFiles(list: FileList | null) {
		if (list) files = [...files, ...Array.from(list)];
	}
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
		<div class="grid grid-cols-1 gap-2">
			<MarkdownField
				id={bodyId}
				bind:value={body}
				minRows={8}
				maxHeight="50vh"
				autofocus
				onsubmit={() => void save()}
				onfiles={(list) => (files = [...files, ...list])}
			>
				{#snippet toolbarEnd()}
					<Toolbar.Button size="sm" class="font-mono" onclick={() => picker?.click()}
						>+ ADD FILES</Toolbar.Button
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
				{/snippet}
			</MarkdownField>
			{#if files.length}
				<ul
					class="grid grid-cols-1 overflow-hidden rounded-lg border border-border font-mono text-xs"
				>
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
