<script lang="ts" module>
	import { getContext, setContext } from "svelte";
	import { toggleVariants } from "#lib/components/ui/toggle/index.js";
	import type { VariantProps } from "tailwind-variants";

	type ToggleVariants = VariantProps<typeof toggleVariants>;

	export function setToolbarGroupCtx(props: ToggleVariants) {
		setContext("toolbarGroup", props);
	}

	export function getToolbarGroupCtx() {
		return getContext<ToggleVariants | undefined>("toolbarGroup");
	}
</script>

<script lang="ts">
	import { Toolbar as ToolbarPrimitive } from "bits-ui";
	import { cn } from "#lib/utils.js";

	let {
		ref = $bindable(null),
		value = $bindable(),
		class: className,
		size = "default",
		variant = "default",
		...restProps
	}: ToolbarPrimitive.GroupProps & ToggleVariants = $props();

	setToolbarGroupCtx({
		get variant() {
			return variant;
		},
		get size() {
			return size;
		},
	});
</script>

<!-- `value` is cast to `never`: discriminated unions and destructuring do not mix. -->
<ToolbarPrimitive.Group
	bind:value={value as never}
	bind:ref
	data-slot="toolbar-group"
	data-variant={variant}
	data-size={size}
	class={cn("group/toolbar-group flex w-fit flex-row items-center gap-1", className)}
	{...restProps}
/>
