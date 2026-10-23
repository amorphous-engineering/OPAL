<script lang="ts">
	import type { LayoutProps } from './$types';
	let { children }: LayoutProps = $props();
</script>

<div class="flex min-h-svh items-center justify-center bg-muted/40 p-4">
	<div class="w-full max-w-sm overflow-hidden rounded-lg border border-border bg-card">
		<div class="flex h-10 items-center border-b border-border px-4">
			<span class="font-mono text-sm font-bold tracking-[0.2em]">OPAL</span>
		</div>
		<div class="p-4">{@render children()}</div>
	</div>
</div>
