<script lang="ts">
	// A detail row whose value edits in place: EDIT → field → Enter saves, Esc cancels.
	import type { Snippet } from 'svelte';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { NativeSelect } from '#lib/components/ui/native-select/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { toastError } from '#lib/components/opal/index.js';
	import { cn } from '#lib/utils.js';

	let {
		label,
		value,
		type = 'text',
		mono = false,
		editable = true,
		options,
		list,
		placeholder,
		maxlength,
		required = false,
		onsave,
		display
	}: {
		label: string;
		value: string | null | undefined;
		type?: 'text' | 'date' | 'email' | 'url' | 'tel' | 'textarea' | 'select';
		mono?: boolean;
		editable?: boolean;
		options?: { value: string; label: string }[];
		list?: string;
		placeholder?: string;
		maxlength?: number;
		required?: boolean;
		onsave: (value: string | null) => Promise<void>;
		/** Custom read rendering (links, state text). */
		display?: Snippet;
	} = $props();

	let editing = $state(false);
	let draft = $state('');
	let busy = $state(false);
	let root = $state<HTMLElement | null>(null);

	function start() {
		draft = value ?? '';
		editing = true;
		queueMicrotask(() => {
			const el = root?.querySelector<HTMLInputElement>('input, select, textarea');
			el?.focus();
			if (el && type !== 'date' && type !== 'select' && 'select' in el) el.select();
		});
	}

	async function save() {
		const next = draft.trim() === '' ? null : draft.trim();
		if (required && next === null) return toastError(new Error(`${label} is required`));
		if (next === (value ?? null)) {
			editing = false;
			return;
		}
		busy = true;
		try {
			await onsave(next);
			editing = false;
		} catch (e) {
			toastError(e);
		} finally {
			busy = false;
		}
	}

	function onkeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			editing = false;
		} else if (e.key === 'Enter' && (type !== 'textarea' || e.metaKey || e.ctrlKey)) {
			e.preventDefault();
			save();
		}
	}
</script>

<tr class="group/row border-b border-border last:border-b-0">
	<th
		scope="row"
		class="w-40 py-1.5 pr-3 pl-3 text-left align-top font-mono text-xs font-medium tracking-wider whitespace-nowrap text-muted-foreground uppercase"
		>{label}</th
	>
	<td class="py-1.5 pr-3 align-top" bind:this={root}>
		{#if editing}
			<div class="flex items-start gap-1.5" role="presentation" {onkeydown}>
				{#if type === 'textarea'}
					<Textarea bind:value={draft} rows={3} class="min-h-16 flex-1 text-xs" {maxlength} />
				{:else if type === 'select'}
					<NativeSelect bind:value={draft} class="flex-1" aria-label={label}>
						{#each options ?? [] as o (o.value)}
							<option value={o.value}>{o.label}</option>
						{/each}
					</NativeSelect>
				{:else}
					<Input
						bind:value={draft}
						{type}
						{list}
						{placeholder}
						{maxlength}
						aria-label={label}
						class={cn('h-7 flex-1 text-xs', mono && 'font-mono')}
					/>
				{/if}
				<Button size="sm" disabled={busy} onclick={save}>SAVE</Button>
				<Button size="sm" variant="ghost" disabled={busy} onclick={() => (editing = false)}
					>CANCEL</Button
				>
			</div>
		{:else}
			<div class="flex items-start gap-3">
				<div class={cn('min-w-0 flex-1', mono && 'font-mono tabular-nums')}>
					{#if display}
						{@render display()}
					{:else if value}
						<span class={cn(type === 'textarea' && 'whitespace-pre-wrap')}>{value}</span>
					{:else}
						<span class="text-muted-foreground">—</span>
					{/if}
				</div>
				{#if editable}
					<button
						type="button"
						class="font-mono text-xs tracking-wider text-muted-foreground uppercase opacity-0 group-hover/row:opacity-100 hover:text-info focus-visible:opacity-100"
						onclick={start}
						aria-label={`Edit ${label}`}>Edit</button
					>
				{/if}
			</div>
		{/if}
	</td>
</tr>
