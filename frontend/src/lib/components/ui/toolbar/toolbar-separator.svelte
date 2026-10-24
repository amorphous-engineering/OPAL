<script lang="ts">
	import { Separator } from "#lib/components/ui/separator/index.js";
	import { cn } from "#lib/utils.js";

	let { class: className, ...restProps }: { class?: string } = $props();
</script>

<Separator
	orientation="vertical"
	data-slot="toolbar-separator"
	class={cn("mx-0.5 h-4 self-center", className)}
	{...restProps}
/>
