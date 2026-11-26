<script lang="ts">
	// The tier choice, on the create form and on a draft part's page: a bank of keys for a few
	// tiers, a select for many. The note under it says what the tier implies for new stock.
	import { Button } from '#lib/components/ui/button/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import type { SchemaTier } from '@opal/shared';

	let {
		tiers,
		value,
		onchange
	}: { tiers: SchemaTier[]; value: number | null; onchange: (tier: number | null) => void } =
		$props();

	const info = $derived(tiers.find((t) => t.level === value));
</script>

<div class="grid grid-cols-1 gap-1">
	{#if tiers.length > 5}
		<NativeSelect.Root
			aria-label="Tier"
			value={value === null ? '' : String(value)}
			onchange={(e) => onchange(e.currentTarget.value ? Number(e.currentTarget.value) : null)}
		>
			<NativeSelect.Option value="">—</NativeSelect.Option>
			{#each tiers as t (t.level)}
				<NativeSelect.Option value={String(t.level)}
					>T{t.level} {t.name.toUpperCase()}</NativeSelect.Option
				>
			{/each}
		</NativeSelect.Root>
	{:else}
		<div class="flex flex-wrap gap-1.5" role="group" aria-label="Tier">
			{#each tiers as t (t.level)}
				<Button
					type="button"
					size="sm"
					variant="outline"
					aria-pressed={value === t.level}
					onclick={() => onchange(t.level)}>T{t.level} {t.name.toUpperCase()}</Button
				>
			{/each}
		</div>
	{/if}
	{#if info}
		<p class="font-mono text-xs text-muted-foreground">
			{info.defaultTracking.toUpperCase()} default{info.requireLot
				? ' · LOT REQUIRED'
				: ''}{info.autoSerial ? ' · AUTO SERIAL' : ''}
		</p>
	{/if}
</div>
