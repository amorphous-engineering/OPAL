<script lang="ts">
	// Running build next to the wordmark. Dev builds (a git checkout) render
	// in blue so a checkout is never mistaken for a release.
	import type { About } from '@opal/shared';

	let { about }: { about: About | null } = $props();
</script>

<a href="/" class="flex min-w-0 items-baseline gap-2 font-mono" title={about?.version}>
	<!-- The wordmark is OPAL orange; it is the one place the brand colour appears. -->
	<span class="text-sm font-bold tracking-[0.2em] text-[var(--brand)]">OPAL</span>
	{#if about}
		<span class="truncate text-xs {about.isDev ? 'text-[var(--dev)]' : 'text-muted-foreground'}"
			>{about.version}</span
		>
	{/if}
</a>
