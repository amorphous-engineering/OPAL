<script lang="ts">
	// Traveler: one write-in line per unit the OP names, plus blank lines for hardware the procedure
	// did not list. Borrowed gear goes on a blank line with who lent it.
	import type { UnitSlot, VersionPart } from '@opal/shared';

	let { slots, partById }: { slots: UnitSlot[]; partById: Map<number, VersionPart> } = $props();
</script>

{#if slots.length}
	<div class="my-1.5 grid gap-1.5 text-[10pt]" data-unit-slots>
		<b class="text-[9pt]">UNITS</b>
		{#each slots as s (s.key)}
			{@const p = partById.get(s.partId)}
			<div class="flex items-baseline gap-2">
				<span class="min-w-32">{s.label}{s.required ? ' *' : ''}</span>
				<span class="font-mono text-[9pt]">{p?.internalPn ?? ''}</span>
				<span class="text-[9pt]">{p?.name ?? ''}</span>
				<span class="ml-auto flex items-baseline gap-1"
					>Serial <span class="inline-block min-w-28 border-b border-black">&nbsp;</span></span
				>
				<span class="flex items-baseline gap-1"
					>OPAL <span class="inline-block min-w-28 border-b border-black">&nbsp;</span></span
				>
			</div>
		{/each}
		{#each [0, 1] as n (n)}
			<div class="flex items-baseline gap-2">
				<span class="min-w-32">Other hardware</span>
				<span class="inline-block flex-1 border-b border-black">&nbsp;</span>
			</div>
		{/each}
		{#if slots.some((s) => s.required)}<span class="text-[8pt]"
				>* required before the OP completes</span
			>{/if}
	</div>
{/if}
