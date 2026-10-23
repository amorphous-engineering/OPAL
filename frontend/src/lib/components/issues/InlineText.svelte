<script lang="ts">
	// In-place text edit: value with an EDIT affordance; Enter (or Ctrl+Enter in a
	// multi-line field) saves, Escape cancels. Empty saves as null unless required.
	import { markdown } from '#lib/markdown.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { toastError } from '#lib/components/opal/index.js';

	let {
		value,
		onsave,
		multiline = false,
		rich = false,
		required = false,
		hint,
		label
	}: {
		value: string | null;
		onsave: (v: string | null) => Promise<void>;
		multiline?: boolean;
		/** Render the value as authored markdown. */
		rich?: boolean;
		required?: boolean;
		/** Muted text shown beside an empty value. */
		hint?: string;
		label: string;
	} = $props();

	let editing = $state(false);
	let draft = $state('');
	let busy = $state(false);

	function start() {
		draft = value ?? '';
		editing = true;
	}

	async function save() {
		const next = draft.trim();
		if (required && !next) return;
		if (next === (value ?? '')) {
			editing = false;
			return;
		}
		busy = true;
		try {
			await onsave(next || null);
			editing = false;
		} catch (e) {
			toastError(e);
		} finally {
			busy = false;
		}
	}

	function key(e: KeyboardEvent) {
		if (e.key === 'Escape') editing = false;
		else if (e.key === 'Enter' && (!multiline || e.ctrlKey || e.metaKey)) {
			e.preventDefault();
			save();
		}
	}
</script>

{#if editing}
	<div class="grid grid-cols-1 gap-1.5 py-0.5">
		{#if multiline}
			<Textarea
				bind:value={draft}
				rows={4}
				aria-label={label}
				onkeydown={key}
				autofocus
				class="min-h-16"
			/>
		{:else}
			<Input bind:value={draft} aria-label={label} onkeydown={key} autofocus />
		{/if}
		<div class="flex gap-1.5">
			<Button size="xs" disabled={busy || (required && !draft.trim())} onclick={save}>SAVE</Button>
			<Button size="xs" variant="outline" onclick={() => (editing = false)}>CANCEL</Button>
		</div>
	</div>
{:else}
	<div class="flex items-start gap-2">
		<div class="min-w-0 flex-1">
			{#if !value}
				<span class="text-muted-foreground"
					>—{#if hint}&nbsp;{hint}{/if}</span
				>
			{:else if rich}
				<!-- eslint-disable-next-line svelte/no-at-html-tags -->
				<div class="prose-opal">{@html markdown(value)}</div>
			{:else}
				<span class="break-words whitespace-pre-wrap">{value}</span>
			{/if}
		</div>
		<button
			type="button"
			class="shrink-0 font-mono text-xs tracking-wider text-info uppercase hover:underline"
			aria-label={`Edit ${label}`}
			onclick={start}>EDIT</button
		>
	</div>
{/if}
