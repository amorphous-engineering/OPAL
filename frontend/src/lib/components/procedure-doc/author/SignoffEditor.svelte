<script lang="ts">
	// OWNED BY AGENT D (authoring). Editable sign-off definitions in the sign-off table's place:
	// label + role per row, remove, + SIGN-OFF. See SPEC.md.
	import type { DocOp, DocStep } from '../types.js';

	let { step, op }: { step: DocStep; op: DocOp } = $props();
</script>

<div data-signoff-editor={step.order} data-op={op.order}></div>
