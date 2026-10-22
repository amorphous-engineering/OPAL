<script lang="ts">
	// Theme is a per-browser preference (mode-watcher stores it locally).
	import { setMode, userPrefersMode } from 'mode-watcher';
	import { DetailRow, DetailTable, Section } from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';

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
			<div class="mt-1 text-[11px] text-muted-foreground">This browser only.</div>
		</DetailRow>
	</DetailTable>
</Section>
