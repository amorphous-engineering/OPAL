<script lang="ts">
	// A date bound to one URL parameter (YYYY-MM-DD), with an inline label.
	import { page } from '$app/state';
	import { Input } from '#lib/components/ui/input/index.js';
	import { setQuery } from './listquery.js';

	let { param, label, min, max }: { param: string; label: string; min?: string; max?: string } =
		$props();
	const value = $derived(page.url.searchParams.get(param) ?? '');
</script>

<label class="flex items-center gap-1.5 text-xs">
	<span class="label">{label}</span>
	<Input
		type="date"
		class="h-7 w-36 font-mono text-xs"
		{value}
		{min}
		{max}
		onchange={(e) => setQuery({ [param]: e.currentTarget.value })}
	/>
</label>
