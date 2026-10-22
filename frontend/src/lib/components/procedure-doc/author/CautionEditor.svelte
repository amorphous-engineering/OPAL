<script lang="ts">
	// The caution block as the operator sees it (red note), as a text field.
	import { useDoc } from '../controller.js';
	import type { DocStep } from '../types.js';

	let { step }: { step: DocStep } = $props();
	const au = useDoc().author!;
	const id = $derived(`caution-${step.order}`);
</script>

<div role="note" class="border border-error/50 bg-error-muted px-3 py-2 text-xs">
	<label for={id} class="label mb-0.5 block text-error">Caution</label>
	<textarea
		{id}
		rows="1"
		class="field-sizing-content min-h-6 w-full resize-none border border-transparent bg-transparent px-1 text-xs whitespace-pre-wrap text-foreground placeholder:text-muted-foreground hover:border-error/30 focus:border-ring focus:bg-background focus:outline-none"
		placeholder="Hazard text, shown in red to the operator"
		value={step.caution ?? ''}
		onkeydown={(e) => e.stopPropagation()}
		oninput={(e) => au.edit(step, { caution: e.currentTarget.value })}></textarea>
</div>
