<script lang="ts">
	// Instructions as markdown, beside the rendering the operator will get. The
	// preview is the same markdown() into the same prose container the document
	// uses. Images upload (button, paste or drop) and insert at the cursor.
	import { Button } from '#lib/components/ui/button/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { toastError } from '#lib/components/opal/index.js';
	import { markdown } from '#lib/markdown.js';
	import { useDoc } from '../controller.js';

	let {
		value,
		onchange,
		label,
		id
	}: { value: string | null; onchange: (v: string) => void; label: string; id: string } = $props();
	const au = useDoc().author!;

	let area = $state<HTMLTextAreaElement | null>(null);
	let uploading = $state(0);
	let picker = $state<HTMLInputElement | null>(null);
	const text = $derived(value ?? '');

	function insert(snippet: string) {
		const ta = area;
		if (!ta) return onchange(text + snippet);
		const a = ta.selectionStart ?? text.length;
		const b = ta.selectionEnd ?? a;
		const next = text.slice(0, a) + snippet + text.slice(b);
		onchange(next);
		queueMicrotask(() => {
			ta.focus();
			ta.setSelectionRange(a + snippet.length, a + snippet.length);
		});
	}

	function wrap(before: string, after = before) {
		const ta = area;
		if (!ta) return;
		const a = ta.selectionStart;
		const b = ta.selectionEnd;
		const sel = text.slice(a, b) || 'text';
		onchange(text.slice(0, a) + before + sel + after + text.slice(b));
		queueMicrotask(() => {
			ta.focus();
			ta.setSelectionRange(a + before.length, a + before.length + sel.length);
		});
	}

	async function upload(files: File[]) {
		for (const f of files.filter((x) => x.type.startsWith('image/'))) {
			uploading++;
			try {
				insert((await au.uploadInline(f)) + '\n');
			} catch (e) {
				toastError(e, 'Image upload failed');
			} finally {
				uploading--;
			}
		}
	}
</script>

<div class="grid grid-cols-1 gap-1.5">
	<div class="flex flex-wrap items-center gap-1">
		<label class="label" for={id}>{label}</label>
		<span class="ml-auto flex items-center gap-1">
			<Button size="xs" variant="ghost" aria-label="Bold" onclick={() => wrap('**')}>B</Button>
			<Button size="xs" variant="ghost" aria-label="Italic" onclick={() => wrap('*')}>I</Button>
			<Button size="xs" variant="ghost" aria-label="Bulleted list" onclick={() => insert('\n- ')}
				>LIST</Button
			>
			<Button size="xs" variant="outline" disabled={uploading > 0} onclick={() => picker?.click()}
				>{uploading ? 'UPLOADING' : 'INSERT IMAGE'}</Button
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
		</span>
	</div>
	<div class="grid grid-cols-1 items-start gap-3 lg:grid-cols-2">
		<Textarea
			{id}
			bind:ref={area}
			class="min-h-24 font-mono"
			value={text}
			placeholder="Instructions in markdown. Paste or drop an image to add it."
			spellcheck="true"
			oninput={(e) => onchange(e.currentTarget.value)}
			onkeydown={(e) => e.stopPropagation()}
			onpaste={(e) => {
				const files = Array.from(e.clipboardData?.files ?? []);
				if (files.some((f) => f.type.startsWith('image/'))) {
					e.preventDefault();
					upload(files);
				}
			}}
			ondragover={(e) => {
				if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
			}}
			ondrop={(e) => {
				const files = Array.from(e.dataTransfer?.files ?? []);
				if (files.length) {
					e.preventDefault();
					upload(files);
				}
			}}
		/>
		<div class="min-h-24 border border-dashed border-border px-3 py-2" aria-label="Rendered">
			{#if text.trim()}
				<!-- eslint-disable-next-line svelte/no-at-html-tags -- markdown() sanitizes -->
				<div class="prose-opal max-w-3xl">{@html markdown(text)}</div>
			{:else}
				<span class="font-mono text-xs text-muted-foreground">—</span>
			{/if}
		</div>
	</div>
</div>
