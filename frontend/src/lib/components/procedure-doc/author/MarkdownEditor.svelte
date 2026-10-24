<script lang="ts">
	// Instructions as markdown in the shared editor (LIVE, HYBRID or SOURCE). Images upload
	// (button, paste or drop) and insert at the cursor. Host snippets add the step's own
	// buttons, callout boxes and save badge to the one header row.
	import type { Snippet } from 'svelte';
	import * as Toolbar from '#lib/components/ui/toolbar/index.js';
	import { MarkdownField } from '#lib/components/markdown/index.js';
	import { toastError } from '#lib/components/opal/index.js';
	import { useDoc } from '../controller.js';

	let {
		value,
		onchange,
		label,
		id,
		actions,
		badge,
		between
	}: {
		value: string | null;
		onchange: (v: string) => void;
		label: string;
		id: string;
		actions?: Snippet;
		badge?: Snippet;
		between?: Snippet;
	} = $props();
	const au = useDoc().author!;

	let field = $state<ReturnType<typeof MarkdownField> | null>(null);
	let uploading = $state(0);
	let picker = $state<HTMLInputElement | null>(null);
	const text = $derived(value ?? '');

	async function upload(files: File[]) {
		for (const f of files.filter((x) => x.type.startsWith('image/'))) {
			uploading++;
			try {
				field?.insert((await au.uploadInline(f)) + '\n');
			} catch (e) {
				toastError(e, 'Image upload failed');
			} finally {
				uploading--;
			}
		}
	}
</script>

<MarkdownField
	{id}
	{label}
	value={text}
	{onchange}
	bind:this={field}
	placeholder="Instructions in markdown. Paste or drop an image to add it."
	minRows={3}
	onfiles={upload}
	{between}
	toolbarTail={badge}
>
	{#snippet toolbarEnd()}
		{@render actions?.()}
		<Toolbar.Button
			size="sm"
			class="font-mono"
			disabled={uploading > 0}
			onclick={() => picker?.click()}>{uploading ? 'UPLOADING' : 'INSERT IMAGE'}</Toolbar.Button
		>
		<input
			bind:this={picker}
			type="file"
			accept="image/*"
			multiple
			hidden
			onchange={(e) => {
				upload(Array.from(e.currentTarget.files ?? []));
				e.currentTarget.value = '';
			}}
		/>
	{/snippet}
</MarkdownField>
