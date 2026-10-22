<script lang="ts">
	// Score in severity colour, with the post-response target after an arrow.
	import { cn } from '#lib/utils.js';
	import { toneText } from '#lib/components/opal/tone.js';
	import { severityTone, type Severity } from './types.js';

	let {
		score,
		severity,
		residual = null,
		residualSeverity = null,
		class: className
	}: {
		score: number;
		severity: Severity;
		residual?: number | null;
		residualSeverity?: Severity | null;
		class?: string;
	} = $props();
</script>

<span class={cn('font-mono tabular-nums', className)}
	><span class={toneText[severityTone[severity]]}>{score}</span
	>{#if residual !== null && residualSeverity}
		<span class="text-muted-foreground"> → </span><span
			class={toneText[severityTone[residualSeverity]]}>{residual}</span
		>{/if}</span
>
