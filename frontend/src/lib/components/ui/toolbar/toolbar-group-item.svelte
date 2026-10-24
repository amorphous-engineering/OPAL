<script lang="ts">
	import { Toolbar as ToolbarPrimitive } from "bits-ui";
	import { type ToggleVariants, toggleVariants } from "#lib/components/ui/toggle/index.js";
	import { cn } from "#lib/utils.js";
	import { getToolbarGroupCtx } from "./toolbar-group.svelte";

	let {
		ref = $bindable(null),
		class: className,
		size,
		variant,
		...restProps
	}: ToolbarPrimitive.GroupItemProps & ToggleVariants = $props();

	const ctx = getToolbarGroupCtx();
</script>

<ToolbarPrimitive.GroupItem
	bind:ref
	data-slot="toolbar-group-item"
	class={cn(
		"shrink-0 focus:z-10 focus-visible:z-10",
		toggleVariants({ variant: ctx?.variant || variant, size: ctx?.size || size }),
		className
	)}
	{...restProps}
/>
