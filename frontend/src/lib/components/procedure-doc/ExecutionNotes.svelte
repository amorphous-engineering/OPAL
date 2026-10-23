<script lang="ts">
	// OWNED BY AGENT C (notes). Execution notes: markdown body, files, + ADD dialog. See SPEC.md.
	import StepNotes from './StepNotes.svelte';
	import type { DocStep } from './types.js';

	let { step }: { step: DocStep } = $props();
</script>

<StepNotes {step} />
