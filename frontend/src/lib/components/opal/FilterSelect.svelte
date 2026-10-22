<script lang="ts">
	// A select bound to one URL parameter. The first option ("All x") is the unfiltered state.
	import { page } from '$app/state';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import { setQuery } from './listquery.js';

	let {
		param,
		label,
		allLabel,
		options,
		fallback = '',
		alsoClear = [],
		class: className
	}: {
		param: string;
		/** Accessible name. */
		label: string;
		/** Text of the empty option; empty string for a select with no unfiltered state. */
		allLabel: string;
		options: readonly { value: string; label: string }[];
		/** Value shown when the parameter is absent (a non-empty default such as `active`). */
		fallback?: string;
		/** Other parameters that stop making sense when this one changes (e.g. a record id). */
		alsoClear?: readonly string[];
		class?: string;
	} = $props();

	const value = $derived(page.url.searchParams.get(param) ?? fallback);

	function change(v: string) {
		// A non-empty default is stored as absence so the clean URL stays canonical.
		setQuery({
			[param]: v === fallback ? null : v,
			...Object.fromEntries(alsoClear.map((k) => [k, null]))
		});
	}
</script>

<NativeSelect.Root
	size="sm"
	aria-label={label}
	class={className}
	{value}
	onchange={(e) => change(e.currentTarget.value)}
>
	{#if allLabel}<NativeSelect.Option value="">{allLabel}</NativeSelect.Option>{/if}
	{#each options as o (o.value)}
		<NativeSelect.Option value={o.value}>{o.label}</NativeSelect.Option>
	{/each}
</NativeSelect.Root>
