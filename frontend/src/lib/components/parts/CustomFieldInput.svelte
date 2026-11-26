<script lang="ts">
	// The control for one custom field. The label is the caller's: a Field on the create form,
	// the detail row's header on the part page.
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import type { CustomFieldDef } from '@opal/shared';

	let {
		field,
		id,
		text = $bindable(''),
		checked = $bindable(false),
		class: className
	}: {
		field: CustomFieldDef;
		id: string;
		text?: string;
		checked?: boolean;
		class?: string;
	} = $props();
</script>

{#if field.type === 'boolean'}
	<Checkbox {id} aria-label={field.label} bind:checked />
{:else if field.type === 'select'}
	<NativeSelect.Root {id} class={className ?? 'w-full'} aria-label={field.label} bind:value={text}>
		<NativeSelect.Option value="">—</NativeSelect.Option>
		{#each field.options as o (o)}<NativeSelect.Option value={o}>{o}</NativeSelect.Option>{/each}
	</NativeSelect.Root>
{:else if field.type === 'number'}
	<!-- A number input binds a number, or null when cleared; the field holds text either way. -->
	<Input
		{id}
		class={className}
		aria-label={field.label}
		type="number"
		step="any"
		bind:value={() => text, (v) => (text = v === null || v === undefined ? '' : String(v))}
	/>
{:else}
	<Input {id} class={className} aria-label={field.label} bind:value={text} />
{/if}
