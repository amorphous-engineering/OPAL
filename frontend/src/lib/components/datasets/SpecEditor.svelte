<script lang="ts">
	import { specText } from '@opal/shared';
	import { Input } from '#lib/components/ui/input/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import {
		SPEC_BOXES,
		SPEC_KIND_LABELS,
		SPEC_KIND_OPTIONS,
		badBoxes,
		specFromDraft,
		type SpecDraft
	} from './spec-draft.js';

	let {
		draft = $bindable(),
		unit = '',
		label = 'Spec'
	}: { draft: SpecDraft; unit?: string; label?: string } = $props();

	const result = $derived(specFromDraft(draft));
	const bad = $derived(badBoxes(draft));
	const boxes = $derived(draft.kind === 'none' ? [] : SPEC_BOXES[draft.kind]);
	const keys = ['a', 'b', 'c'] as const;
</script>

<div class="grid grid-cols-1 gap-1">
	<div class="flex items-center gap-1.5">
		<NativeSelect bind:value={draft.kind} aria-label={`${label} kind`} class="w-32">
			{#each SPEC_KIND_OPTIONS as k (k)}
				<NativeSelectOption value={k}>{SPEC_KIND_LABELS[k]}</NativeSelectOption>
			{/each}
		</NativeSelect>
		{#each boxes as box, i (box)}
			<Input
				bind:value={draft[keys[i]]}
				inputmode="decimal"
				placeholder={box}
				aria-label={`${label} ${box.toLowerCase()}`}
				aria-invalid={bad[i] || undefined}
				class="w-20 font-mono"
			/>
		{/each}
	</div>
	{#if result.spec}
		<p class="font-mono text-xs text-muted-foreground">Spec {specText(result.spec, unit)}</p>
	{:else if result.error}
		<p class="text-xs text-error">{result.error}</p>
	{/if}
</div>
