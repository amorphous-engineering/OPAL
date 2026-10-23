<script lang="ts">
	// A title that is its own text field: reads as the row's title, edits in place.
	import { cn } from '#lib/utils.js';
	import { useDoc } from '../controller.js';
	import type { DocStep } from '../types.js';

	let { step, class: className }: { step: DocStep; class?: string } = $props();
	const au = useDoc().author!;
</script>

<input
	type="text"
	data-title-input={step.order}
	class={cn(
		'min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1 py-0.5 text-sm hover:border-border focus:border-ring focus:bg-background focus:outline-none',
		!step.title.trim() && 'border-error/60',
		className
	)}
	value={step.title}
	maxlength={255}
	placeholder="Title"
	aria-label={`Title of ${step.number}`}
	aria-invalid={!step.title.trim()}
	onclick={(e) => e.stopPropagation()}
	onkeydown={(e) => {
		e.stopPropagation();
		if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
	}}
	oninput={(e) => au.edit(step, { title: e.currentTarget.value })}
/>
