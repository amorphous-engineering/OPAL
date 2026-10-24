<script lang="ts">
	import { Toolbar as ToolbarPrimitive } from "bits-ui";
	import { cn } from "#lib/utils.js";

	let {
		ref = $bindable(null),
		class: className,
		...restProps
	}: ToolbarPrimitive.RootProps = $props();
</script>

<ToolbarPrimitive.Root
	bind:ref
	data-slot="toolbar"
	class={cn("flex flex-wrap items-center gap-1", className)}
	{...restProps}
/>
