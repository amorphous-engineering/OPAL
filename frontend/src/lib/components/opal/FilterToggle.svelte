<script lang="ts">
	// A checkbox bound to one URL parameter (`1` when on).
	import { page } from '$app/state';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import { setQuery } from './listquery.js';

	let { param, label }: { param: string; label: string } = $props();
	const on = $derived(!!page.url.searchParams.get(param));
</script>

<label class="flex items-center gap-1.5 text-xs">
	<Checkbox checked={on} onCheckedChange={(v) => setQuery({ [param]: v === true })} />
	<span class="label">{label}</span>
</label>
