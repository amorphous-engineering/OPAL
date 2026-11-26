<script lang="ts">
	// One form for create (page) and edit (in its section). Code is uppercased by the server. With
	// a title it draws its own box and puts its keys below it, as every create page does.
	import { Field, FormKeys, needs, Section } from '#lib/components/opal/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import { untrack } from 'svelte';
	import type { WorkcenterInput } from './types.js';

	let {
		initial,
		submitLabel,
		busy = false,
		error = null,
		onsubmit,
		cancel,
		showActive = true,
		title
	}: {
		initial?: Partial<WorkcenterInput>;
		submitLabel: string;
		busy?: boolean;
		error?: string | null;
		onsubmit: (v: WorkcenterInput) => void;
		cancel?: string | (() => void);
		/** The active switch. Off on the edit page, where DEACTIVATE is its own act. */
		showActive?: boolean;
		title?: string;
	} = $props();

	// The form seeds once; callers remount it ({#key}) to reseed.
	const init = untrack(() => initial);
	let code = $state(init?.code ?? '');
	let name = $state(init?.name ?? '');
	let location = $state(init?.location ?? '');
	let description = $state(init?.description ?? '');
	let active = $state(init?.isActive ?? true);

	const missing = $derived(needs({ code: code.trim(), name: name.trim() }));

	function submit(e: SubmitEvent) {
		e.preventDefault();
		onsubmit({
			code: code.trim(),
			name: name.trim(),
			location: location.trim() || null,
			description: description.trim() || null,
			isActive: active
		});
	}
</script>

<form class="grid grid-cols-1 gap-3" onsubmit={submit}>
	{#if title}
		<Section {title}>
			<div class="grid grid-cols-1 gap-3 p-3">{@render fields()}</div>
		</Section>
	{:else}
		{@render fields()}
	{/if}
	<FormKeys submit={submitLabel} {cancel} {missing} {busy} {error} />
</form>

{#snippet fields()}
	<Field label="Code" for="wc-code" required>
		<Input
			id="wc-code"
			class="w-40 font-mono uppercase"
			bind:value={code}
			required
			maxlength={50}
			autocomplete="off"
		/>
	</Field>
	<Field label="Name" for="wc-name" required>
		<Input id="wc-name" bind:value={name} required maxlength={255} />
	</Field>
	<Field label="Location" for="wc-loc">
		<Input id="wc-loc" bind:value={location} maxlength={255} />
	</Field>
	<Field label="Description" for="wc-desc">
		<Textarea id="wc-desc" bind:value={description} rows={3} />
	</Field>
	{#if showActive}
		<div class="flex items-center gap-2">
			<Switch id="wc-active" bind:checked={active} />
			<Label for="wc-active">Active</Label>
		</div>
	{/if}
{/snippet}
