<script lang="ts">
	import type { LayoutProps } from './$types';
	let { children }: LayoutProps = $props();
</script>

<!-- Paper is always white on black, whatever the app theme. -->
<div class="paper min-h-svh bg-white text-black">
	{@render children()}
</div>

<style>
	@media print {
		:global(html),
		:global(body) {
			background: #fff !important;
		}
	}
</style>
