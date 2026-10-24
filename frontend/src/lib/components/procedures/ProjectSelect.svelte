<script lang="ts">
	// The project of a template: a required choice among the active projects. With exactly
	// one active project and nothing chosen yet, that project is pre-selected.
	import { opal } from '#lib/api.js';
	import { toastError } from '#lib/components/opal/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import type { Project } from '@opal/shared';

	let {
		value = $bindable(0),
		id,
		keep
	}: {
		/** The chosen project id; 0 when none. */
		value: number;
		id?: string;
		/** A project to list even when archived: the one the record already has. */
		keep?: number;
	} = $props();

	let projects = $state<Project[]>([]);
	let loaded = $state(false);

	$effect(() => {
		opal.org.projects
			.list({ limit: 500 })
			.then((r) => {
				projects = r.items.filter((p) => p.state === 'active' || p.id === keep);
				const active = projects.filter((p) => p.state === 'active');
				if (!value && active.length === 1) value = active[0].id;
			})
			.catch(toastError)
			.finally(() => (loaded = true));
	});
</script>

<NativeSelect
	{id}
	required
	value={value ? String(value) : ''}
	onchange={(e) => (value = Number(e.currentTarget.value) || 0)}
	class="max-w-xs"
>
	{#if !value}<NativeSelectOption value="">{loaded ? 'Choose a project' : '…'}</NativeSelectOption
		>{/if}
	{#each projects as p (p.id)}
		<NativeSelectOption value={String(p.id)}>{p.code} {p.name}</NativeSelectOption>
	{/each}
</NativeSelect>
