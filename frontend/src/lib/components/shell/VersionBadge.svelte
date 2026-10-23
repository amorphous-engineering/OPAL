<script lang="ts">
	// Running build next to the wordmark. Dev builds (a git checkout) render
	// in blue so a checkout is never mistaken for a release.
	import { onMount } from 'svelte';
	import { api } from '#lib/api.js';

	interface Health {
		display: string;
		is_dev: boolean;
		tooltip: string;
	}

	let health = $state<Health | null>(null);

	onMount(async () => {
		try {
			health = await api.get<Health>('/health');
		} catch {
			health = null;
		}
	});
</script>

<a href="/" class="flex min-w-0 items-baseline gap-2 font-mono" title={health?.tooltip}>
	<!-- The wordmark is OPAL orange; it is the one place the brand colour appears. -->
	<span class="text-sm font-bold tracking-[0.2em] text-[var(--brand)]">OPAL</span>
	{#if health}
		<span class="truncate text-xs {health.is_dev ? 'text-[var(--dev)]' : 'text-muted-foreground'}"
			>{health.display}</span
		>
	{/if}
</a>
