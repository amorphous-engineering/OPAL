<script lang="ts">
	// OWNED BY AGENT B (sign-offs). The step's sign-off table (execute and readonly modes):
	// one row per slot — label, role, signature, COMPLETE chip or SIGN OFF. See SPEC.md.
	import type { DocOp, DocStep } from './types.js';

	let { step, op }: { step: DocStep; op: DocOp } = $props();
</script>

<div data-signoffs={step.order} data-op={op.order}></div>
