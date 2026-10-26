<script lang="ts">
	// A `project-map` setting: one row per OPAL project, each with a value from
	// the plugin's options. Without options (plugin not running), rows take text.
	import { opal } from '#lib/api.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import type { PluginOptions } from '@opal/shared';

	let {
		id,
		value = $bindable({}),
		options
	}: {
		id: string;
		value: Record<string, string>;
		options: PluginOptions['items'] | null;
	} = $props();

	let projects = $state<{ code: string; name: string }[]>([]);
	$effect(() => {
		void opal.org.projects
			.list({ limit: 500 })
			.then((p) => (projects = p.items))
			.catch(() => (projects = []));
	});

	// Codes saved earlier for a project that no longer lists still show.
	const rows = $derived([
		...projects,
		...Object.keys(value)
			.filter((c) => !projects.some((p) => p.code === c))
			.map((code) => ({ code, name: '' }))
	]);

	function set(code: string, v: string) {
		const next = { ...value };
		if (v) next[code] = v;
		else delete next[code];
		value = next;
	}
</script>

<table {id} class="w-full border border-border text-sm">
	<thead>
		<tr
			class="border-b border-border text-left font-mono text-xs tracking-wider text-muted-foreground"
		>
			<th class="w-1/2 px-2 py-1.5 font-medium">PROJECT</th>
			<th class="px-2 py-1.5 font-medium">VALUE</th>
		</tr>
	</thead>
	<tbody>
		{#each rows as p (p.code)}
			<tr class="border-b border-border last:border-b-0">
				<td class="px-2 py-1">
					<span class="font-mono text-xs">{p.code}</span>
					{#if p.name}<span class="ml-1 text-muted-foreground">{p.name}</span>{/if}
				</td>
				<td class="px-2 py-1">
					{#if options}
						<NativeSelect
							class="w-full"
							value={value[p.code] ?? ''}
							onchange={(e: Event) => set(p.code, (e.currentTarget as HTMLSelectElement).value)}
						>
							<NativeSelectOption value="">—</NativeSelectOption>
							{#each options as o (o.value)}
								<NativeSelectOption value={o.value}>{o.label}</NativeSelectOption>
							{/each}
							{#if value[p.code] && !options.some((o) => o.value === value[p.code])}
								<NativeSelectOption value={value[p.code]}>{value[p.code]}</NativeSelectOption>
							{/if}
						</NativeSelect>
					{:else}
						<Input
							class="h-7 font-mono text-xs"
							autocomplete="off"
							value={value[p.code] ?? ''}
							oninput={(e: Event) =>
								set(p.code, (e.currentTarget as HTMLInputElement).value.trim())}
						/>
					{/if}
				</td>
			</tr>
		{:else}
			<tr><td colspan="2" class="px-2 py-1.5 text-muted-foreground">No projects.</td></tr>
		{/each}
	</tbody>
</table>
