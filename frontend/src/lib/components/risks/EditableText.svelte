<script lang="ts">
	// In-place editing of one text fact: the value, an EDIT control, and on
	// click an input with SAVE / CANCEL (Ctrl+Enter saves, Escape cancels).
	import type { Snippet } from 'svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { toastError } from '#lib/components/opal/index.js';
	import { MarkdownField } from '#lib/components/markdown/index.js';
	import LintField from './LintField.svelte';

	let {
		value,
		onsave,
		lint,
		multiline = false,
		mono = false,
		maxlength,
		label,
		placeholder,
		readonly = false,
		display,
		editing = $bindable(false)
	}: {
		value: string | null;
		/** Persist the new value (null clears). Return false to stay in the editor. */
		onsave: (next: string | null) => Promise<boolean | void>;
		lint?: 'condition' | 'departure' | 'consequence';
		multiline?: boolean;
		mono?: boolean;
		maxlength?: number;
		/** Accessible name for the field. */
		label: string;
		placeholder?: string;
		readonly?: boolean;
		/** Custom read-only rendering of the value (e.g. markdown). */
		display?: Snippet<[string]>;
		/** Bindable so a parent can open the editor (e.g. from an empty-state line). */
		editing?: boolean;
	} = $props();

	let draft = $state('');
	let busy = $state(false);

	let wasEditing = false;
	$effect(() => {
		if (editing && !wasEditing) draft = value ?? '';
		wasEditing = editing;
	});

	function start() {
		editing = true;
	}

	async function save() {
		const next = draft.trim() || null;
		if (next === (value ?? null)) {
			editing = false;
			return;
		}
		busy = true;
		try {
			if ((await onsave(next)) !== false) editing = false;
		} catch (e) {
			toastError(e);
		} finally {
			busy = false;
		}
	}

	function onEscape(e: KeyboardEvent) {
		if (e.key === 'Escape') editing = false;
	}

	function onkeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || !multiline)) {
			e.preventDefault();
			save();
		} else if (e.key === 'Escape') {
			editing = false;
		}
	}
</script>

{#if editing}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="grid grid-cols-1 gap-1.5"
		onkeydown={display && multiline && !lint ? onEscape : undefined}
	>
		{#if lint}
			<LintField field={lint} bind:value={draft} {onkeydown} />
		{:else if multiline && display}
			<MarkdownField
				bind:value={draft}
				ariaLabel={label}
				{placeholder}
				minRows={3}
				autofocus
				onsubmit={save}
			/>
		{:else if multiline}
			<Textarea
				aria-label={label}
				bind:value={draft}
				{onkeydown}
				{placeholder}
				class={mono ? 'font-mono' : ''}
				rows={3}
			/>
		{:else}
			<Input
				aria-label={label}
				bind:value={draft}
				{onkeydown}
				{placeholder}
				{maxlength}
				class={mono ? 'font-mono' : ''}
			/>
		{/if}
		<div class="flex gap-1.5">
			<Button size="xs" onclick={save} disabled={busy}>SAVE</Button>
			<Button size="xs" variant="outline" onclick={() => (editing = false)}>CANCEL</Button>
		</div>
	</div>
{:else}
	<div class="flex items-start gap-2">
		<div
			class={['min-w-0 flex-1', !display && 'break-words whitespace-pre-wrap', mono && 'font-mono']}
		>
			{#if value}
				{#if display}{@render display(value)}{:else}{value}{/if}
			{:else}
				<span class="text-muted-foreground">—</span>
			{/if}
		</div>
		{#if !readonly}
			<button
				type="button"
				class="label shrink-0 hover:text-foreground"
				aria-label={`Edit ${label}`}
				onclick={start}>EDIT</button
			>
		{/if}
	</div>
{/if}
