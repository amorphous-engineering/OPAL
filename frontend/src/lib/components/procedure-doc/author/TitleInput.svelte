<script lang="ts">
	// A title that is its own text field: reads as the row's title, edits in place.
	import { cn } from '#lib/utils.js';
	import { useDoc } from '../controller.js';
	import type { DocStep } from '../types.js';

	let { step, class: className }: { step: DocStep; class?: string } = $props();
	const ctl = useDoc();
	const au = ctl.author!;
</script>

<input
	type="text"
	data-title-input={step.order}
	class={cn(
		// Dashed like every field that is still pencil, so a title reads as editable.
		'min-w-0 flex-1 border border-dashed border-foreground bg-background px-1.5 py-0.5 text-sm focus:border-solid focus:border-ring focus:outline-none',
		!step.title.trim() && 'border-error',
		className
	)}
	value={step.title}
	maxlength={255}
	placeholder="Title"
	aria-label={`Title of ${step.number}`}
	aria-invalid={!step.title.trim()}
	onclick={(e) => e.stopPropagation()}
	onfocus={() => ctl.setFocus(step.order)}
	onkeydown={(e) => {
		e.stopPropagation();
		if (e.key === 'Enter' || e.key === 'Escape') (e.currentTarget as HTMLInputElement).blur();
	}}
	oninput={(e) => au.edit(step, { title: e.currentTarget.value })}
/>
