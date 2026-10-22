<script lang="ts">
	// Statement text with lint findings underlined (block = red, warn = yellow).
	import { cn } from '#lib/utils.js';
	import { lintSegments } from './lint.js';
	import type { Finding } from './types.js';

	let {
		text,
		findings = [],
		class: className
	}: { text: string; findings?: Finding[]; class?: string } = $props();
	const segments = $derived(lintSegments(text, findings));
</script>

<span class={className}
	>{#each segments as s, i (i)}{#if s.severity}<span
				title={s.title}
				class={cn(
					'underline decoration-wavy underline-offset-2',
					s.severity === 'block' ? 'decoration-error' : 'decoration-warn'
				)}>{s.text}</span
			>{:else}{s.text}{/if}{/each}</span
>
