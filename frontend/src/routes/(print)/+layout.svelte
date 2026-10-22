<script lang="ts">
	import type { LayoutProps } from './$types';
	let { children }: LayoutProps = $props();
</script>

<div class="min-h-svh bg-muted/40 print:bg-white">
	{@render children()}
</div>
