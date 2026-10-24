<script lang="ts">
	// The one markdown editor: CodeMirror 6 with three view modes (LIVE, HYBRID, SOURCE) and the
	// shared formatting toolbar. The mode is a per-viewer preference common to every editor.
	import type { Snippet } from 'svelte';
	import { untrack } from 'svelte';
	import { Compartment, EditorState, Prec } from '@codemirror/state';
	import { EditorView, keymap, placeholder as placeholderExt } from '@codemirror/view';
	import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
	import { syntaxHighlighting } from '@codemirror/language';
	import { markdown, markdownKeymap } from '@codemirror/lang-markdown';
	import { GFM } from '@lezer/markdown';
	import * as Toolbar from '#lib/components/ui/toolbar/index.js';
	import { cn } from '#lib/utils.js';
	import {
		activeMarks,
		type Mark,
		bold,
		bulletList,
		code,
		heading,
		italic,
		link,
		numberedList,
		quote,
		strike,
		underline,
		type Command
	} from './commands.js';
	import { livePreview } from './livePreview.js';
	import { MARKDOWN_MODES, markdownMode, setMarkdownMode } from './mode.svelte.js';
	import { sourceHighlight, theme } from './theme.js';

	let {
		value = $bindable(''),
		onchange,
		id,
		label,
		ariaLabel,
		placeholder,
		minRows = 4,
		maxHeight,
		autofocus = false,
		onsubmit,
		onfiles,
		toolbarEnd,
		toolbarTail,
		between,
		class: className
	}: {
		value: string;
		onchange?: (v: string) => void;
		id?: string;
		label?: string;
		/** Accessible name when no visible label names the editor. */
		ariaLabel?: string;
		placeholder?: string;
		minRows?: number;
		maxHeight?: string;
		autofocus?: boolean;
		onsubmit?: () => void;
		onfiles?: (files: File[]) => void;
		/** Host buttons, before the mode switch. */
		toolbarEnd?: Snippet;
		/** Host content after the mode switch (a save badge). */
		toolbarTail?: Snippet;
		/** Host content between the toolbar row and the editor (callout boxes). */
		between?: Snippet;
		class?: string;
	} = $props();

	let root = $state<HTMLDivElement | null>(null);
	let host = $state<HTMLDivElement | null>(null);
	let view: EditorView | null = null;
	let marks = $state<Mark[]>([]);
	const modeConf = new Compartment();

	function modeExt(mode: (typeof MARKDOWN_MODES)[number]) {
		return [
			EditorView.editorAttributes.of({ class: `cm-mode-${mode}` }),
			mode === 'source' ? syntaxHighlighting(sourceHighlight) : livePreview(mode === 'hybrid')
		];
	}

	/** Insert text at the cursor (replacing the selection) and keep the focus. */
	export function insert(text: string): void {
		if (!view) return;
		const r = view.state.selection.main;
		view.dispatch({
			changes: { from: r.from, to: r.to, insert: text },
			selection: { anchor: r.from + text.length },
			scrollIntoView: true,
			userEvent: 'input.paste'
		});
		view.focus();
	}

	export function focus(): void {
		view?.focus();
	}

	function run(cmd: Command) {
		if (!view) return;
		cmd(view);
		view.focus();
	}

	$effect(() => {
		if (!host) return;
		const rows = untrack(() => minRows);
		const maxH = untrack(() => maxHeight);
		const fmt = (cmd: Command) => (v: EditorView) => cmd(v);
		const v = new EditorView({
			parent: host,
			state: EditorState.create({
				doc: untrack(() => value ?? ''),
				extensions: [
					history(),
					Prec.highest(
						keymap.of([
							{
								key: 'Mod-Enter',
								run: () => {
									if (!onsubmit) return false;
									onsubmit();
									return true;
								}
							},
							{ key: 'Mod-b', run: fmt(bold) },
							{ key: 'Mod-i', run: fmt(italic) },
							{ key: 'Mod-u', run: fmt(underline) },
							{ key: 'Mod-k', run: fmt(link) }
						])
					),
					keymap.of([...markdownKeymap, ...historyKeymap, ...defaultKeymap]),
					markdown({ extensions: GFM }),
					EditorView.lineWrapping,
					theme,
					EditorView.theme({
						'.cm-scroller': { minHeight: `${rows * 1.625 + 1}em` },
						'&': maxH ? { maxHeight: maxH } : {}
					}),
					EditorView.contentAttributes.of({
						...(id ? { id } : {}),
						'aria-label': label ?? ariaLabel ?? 'Markdown',
						spellcheck: 'true'
					}),
					placeholder ? placeholderExt(placeholder) : [],
					modeConf.of(modeExt(untrack(() => markdownMode.value))),
					EditorView.updateListener.of((u) => {
						if (u.docChanged || u.selectionSet) {
							const m = activeMarks(u.state);
							if (m.join() !== marks.join()) marks = m;
						}
						if (!u.docChanged) return;
						const next = u.state.doc.toString();
						if (next === value) return;
						value = next;
						onchange?.(next);
					}),
					EditorView.domEventHandlers({
						paste(e) {
							const files = Array.from(e.clipboardData?.files ?? []);
							if (!files.length || !onfiles) return false;
							e.preventDefault();
							onfiles(files);
							return true;
						},
						drop(e) {
							const files = Array.from(e.dataTransfer?.files ?? []);
							if (!files.length || !onfiles) return false;
							e.preventDefault();
							onfiles(files);
							return true;
						},
						dragover(e) {
							if (!onfiles || !e.dataTransfer?.types.includes('Files')) return false;
							e.preventDefault();
							return true;
						}
					})
				]
			})
		});
		view = v;
		if (untrack(() => autofocus)) v.focus();
		// A host <label for={id}> cannot name or focus a contenteditable; wire it by hand.
		const ext =
			!label && id ? document.querySelector<HTMLLabelElement>(`label[for="${id}"]`) : null;
		const focusEditor = () => v.focus();
		if (ext) {
			ext.id ||= `${id}-label`;
			v.contentDOM.removeAttribute('aria-label');
			v.contentDOM.setAttribute('aria-labelledby', ext.id);
			ext.addEventListener('click', focusEditor);
		}
		return () => {
			ext?.removeEventListener('click', focusEditor);
			v.destroy();
			view = null;
		};
	});

	// Mode switch reaches every open editor through the shared state.
	$effect(() => {
		const mode = markdownMode.value;
		view?.dispatch({ effects: modeConf.reconfigure(modeExt(mode)) });
	});

	// External value changes: replace only the differing middle so the cursor survives.
	$effect(() => {
		const next = value ?? '';
		const v = view;
		if (!v) return;
		const cur = v.state.doc.toString();
		if (cur === next) return;
		let a = 0;
		const max = Math.min(cur.length, next.length);
		while (a < max && cur[a] === next[a]) a++;
		let b = 0;
		while (b < max - a && cur[cur.length - 1 - b] === next[next.length - 1 - b]) b++;
		v.dispatch({
			changes: { from: a, to: cur.length - b, insert: next.slice(a, next.length - b) }
		});
	});

	// The template editor has single-key shortcuts on window; typing must not reach them.
	$effect(() => {
		const el = root;
		if (!el) return;
		const stop = (e: KeyboardEvent) => {
			if (e.key !== 'Escape') e.stopPropagation();
		};
		el.addEventListener('keydown', stop);
		return () => el.removeEventListener('keydown', stop);
	});

	const marked: { mark: Mark; label: string; title: string; cmd: Command; cls: string }[] = [
		{ mark: 'bold', label: 'B', title: 'Bold', cmd: bold, cls: 'font-bold' },
		{ mark: 'italic', label: 'I', title: 'Italic', cmd: italic, cls: 'italic' },
		{ mark: 'underline', label: 'U', title: 'Underline', cmd: underline, cls: 'underline' },
		{ mark: 'strike', label: 'S', title: 'Strikethrough', cmd: strike, cls: 'line-through' }
	];

	/** Square inner corners so a run of buttons reads as one segmented control. */
	const joined = (i: number, n: number) =>
		cn(i > 0 && '-ml-px rounded-l-none', i < n - 1 && 'rounded-r-none');

	const tools: { label: string; title: string; cmd: Command }[][] = [
		[
			{ label: 'H1', title: 'Heading 1', cmd: heading(1) },
			{ label: 'H2', title: 'Heading 2', cmd: heading(2) }
		],
		[{ label: '>', title: 'Quote', cmd: quote }],
		[
			{ label: '•', title: 'Bulleted list', cmd: bulletList },
			{ label: '1.', title: 'Numbered list', cmd: numberedList }
		],
		[
			{ label: 'link', title: 'Link', cmd: link },
			{ label: '</>', title: 'Code', cmd: code }
		]
	];
</script>

<div bind:this={root} class={cn('grid grid-cols-1 gap-2', className)}>
	<Toolbar.Root aria-label="Formatting">
		{#if label}
			<label class="label mr-1" for={id}>{label}</label>
		{/if}
		<Toolbar.Group type="multiple" value={marks} size="sm" variant="outline" class="gap-0">
			{#each marked as t, i (t.mark)}
				<Toolbar.GroupItem
					value={t.mark}
					class={cn('px-1.5 font-mono', t.cls, joined(i, marked.length))}
					title={t.title}
					aria-label={t.title}
					onmousedown={(e) => e.preventDefault()}
					onclick={() => run(t.cmd)}>{t.label}</Toolbar.GroupItem
				>
			{/each}
		</Toolbar.Group>
		{#each tools as group, gi (gi)}
			<span class="flex items-center">
				{#each group as t, i (t.title)}
					<Toolbar.Button
						size="sm"
						class={cn('px-1.5 font-mono', joined(i, group.length))}
						title={t.title}
						aria-label={t.title}
						onmousedown={(e) => e.preventDefault()}
						onclick={() => run(t.cmd)}>{t.label}</Toolbar.Button
					>
				{/each}
			</span>
		{/each}
		<span class="ml-auto flex flex-wrap items-center gap-1">
			{@render toolbarEnd?.()}
			<Toolbar.Group
				type="single"
				value={markdownMode.value}
				onValueChange={(v: string) => v && setMarkdownMode(v as (typeof MARKDOWN_MODES)[number])}
				size="sm"
				variant="outline"
				class="gap-0"
				aria-label="View mode"
			>
				{#each MARKDOWN_MODES as m, i (m)}
					<Toolbar.GroupItem
						value={m}
						class={cn(
							'font-mono uppercase',
							joined(i, MARKDOWN_MODES.length),
							'data-[state=on]:bg-foreground data-[state=on]:text-background'
						)}
						onmousedown={(e) => e.preventDefault()}>{m}</Toolbar.GroupItem
					>
				{/each}
			</Toolbar.Group>
			{@render toolbarTail?.()}
		</span>
	</Toolbar.Root>
	{@render between?.()}
	<div bind:this={host} class="min-w-0"></div>
</div>
