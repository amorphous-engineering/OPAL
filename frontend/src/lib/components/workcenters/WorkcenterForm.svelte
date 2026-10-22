<script lang="ts">
	// One form for create (page) and edit (dialog). Code is uppercased by the server.
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import { untrack, type Snippet } from 'svelte';
	import type { WorkcenterInput } from './types.js';

	let {
		initial,
		submitLabel,
		busy = false,
		error = null,
		onsubmit,
		cancel
	}: {
		initial?: Partial<WorkcenterInput>;
		submitLabel: string;
		busy?: boolean;
		error?: string | null;
		onsubmit: (v: WorkcenterInput) => void;
		cancel: Snippet;
	} = $props();

	// The form seeds once; callers remount it ({#key}) to reseed.
	const init = untrack(() => initial);
	let code = $state(init?.code ?? '');
	let name = $state(init?.name ?? '');
	let location = $state(init?.location ?? '');
	let description = $state(init?.description ?? '');
	let active = $state(init?.is_active ?? true);

	function submit(e: SubmitEvent) {
		e.preventDefault();
		onsubmit({
			code: code.trim(),
			name: name.trim(),
			location: location.trim() || null,
			description: description.trim() || null,
			is_active: active
		});
	}
</script>

<form class="grid gap-3" onsubmit={submit}>
	<div class="grid gap-1.5">
		<Label for="wc-code">Code</Label>
		<Input
			id="wc-code"
			class="w-40 font-mono uppercase"
			bind:value={code}
			required
			maxlength={50}
			placeholder="AB1"
		/>
	</div>
	<div class="grid gap-1.5">
		<Label for="wc-name">Name</Label>
		<Input id="wc-name" bind:value={name} required maxlength={255} />
	</div>
	<div class="grid gap-1.5">
		<Label for="wc-loc">Location</Label>
		<Input id="wc-loc" bind:value={location} maxlength={255} />
	</div>
	<div class="grid gap-1.5">
		<Label for="wc-desc">Description</Label>
		<Textarea id="wc-desc" bind:value={description} rows={3} />
	</div>
	<div class="flex items-center gap-2">
		<Switch id="wc-active" bind:checked={active} />
		<Label for="wc-active">Active</Label>
	</div>
	{#if error}
		<p role="alert" class="border border-error/40 bg-error-muted px-2 py-1.5 text-xs text-error">
			{error}
		</p>
	{/if}
	<div class="flex justify-end gap-2">
		{@render cancel()}
		<Button type="submit" disabled={busy || !code.trim() || !name.trim()}>{submitLabel}</Button>
	</div>
</form>
