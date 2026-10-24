<script lang="ts">
	import { Toolbar as ToolbarPrimitive } from "bits-ui";
	import { type ToggleVariants, toggleVariants } from "#lib/components/ui/toggle/index.js";
	import { cn } from "#lib/utils.js";

	let {
		ref = $bindable(null),
		class: className,
		size = "default",
		variant = "outline",
		...restProps
	}: ToolbarPrimitive.ButtonProps & ToggleVariants = $props();
</script>

<ToolbarPrimitive.Button
	bind:ref
	data-slot="toolbar-button"
	class={cn("shrink-0 cursor-pointer", toggleVariants({ variant, size }), className)}
	{...restProps}
/>
