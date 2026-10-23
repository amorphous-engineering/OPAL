<script lang="ts">
	import { Pagination as PaginationPrimitive } from "bits-ui";
	import CaretLeftIcon from 'phosphor-svelte/lib/CaretLeft';
	import { buttonVariants } from "#lib/components/ui/button/index.js";
	import { cn } from "#lib/utils.js";

	let {
		ref = $bindable(null),
		class: className,
		...restProps
	}: PaginationPrimitive.PrevButtonProps = $props();
</script>

<PaginationPrimitive.PrevButton
	bind:ref
	aria-label="Go to previous page"
	class={cn(
		buttonVariants({ variant: "ghost", size: "default" }),
		"pl-2!",
		className
	)}
	{...restProps}
>
	<CaretLeftIcon data-icon="inline-start" class="cn-rtl-flip" />
	<span class="hidden sm:block">Previous</span>
</PaginationPrimitive.PrevButton>
