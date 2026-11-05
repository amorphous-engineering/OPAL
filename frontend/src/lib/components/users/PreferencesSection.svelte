<script lang="ts">
	// Theme and step text are per-browser preferences, stored locally.
	import { setMode, userPrefersMode } from 'mode-watcher';
	import { DetailRow, DetailTable, Section } from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { STEP_TEXT_SIZES, setStepText, stepText } from '#lib/stepText.svelte.js';

	const modes = [
		{ value: 'system', label: 'SYSTEM' },
		{ value: 'light', label: 'LIGHT' },
		{ value: 'dark', label: 'DARK' }
	] as const;
</script>

<Section title="Preferences">
	<DetailTable>
		<DetailRow label="Theme">
			<div class="flex items-center gap-1" role="group" aria-label="Theme">
				{#each modes as m (m.value)}
					<Button
						size="xs"
						variant={userPrefersMode.current === m.value ? 'default' : 'outline'}
						aria-pressed={userPrefersMode.current === m.value}
						onclick={() => setMode(m.value)}>{m.label}</Button
					>
				{/each}
			</div>
			<div class="mt-1 text-xs text-muted-foreground">This browser only.</div>
		</DetailRow>
		<DetailRow label="Step text">
			<div class="flex items-center gap-1" role="group" aria-label="Step text">
				{#each STEP_TEXT_SIZES as s (s)}
					<Button
						size="xs"
						variant={stepText.value === s ? 'default' : 'outline'}
						aria-pressed={stepText.value === s}
						onclick={() => setStepText(s)}>{s} PX</Button
					>
				{/each}
			</div>
			<div class="mt-1 text-xs text-muted-foreground">This browser only.</div>
		</DetailRow>
	</DetailTable>
</Section>
