<script lang="ts">
	// Authoring: the existing units an OP names when it runs (a test names the unit under test and
	// its fixture). One serialized part per slot. The key is set once from the first label and never
	// edited, so a kit line that installs into the slot keeps pointing at it.
	import type { UnitSlot } from '@opal/shared';
	import { ActionLink } from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import PartPicker from '#lib/components/parts/PartPicker.svelte';
	import { useDoc, type PartHit } from '#lib/components/procedure-doc/controller.js';
	import type { DocStep } from '#lib/components/procedure-doc/types.js';

	let { step }: { step: DocStep } = $props();
	const au = useDoc().author!;

	const slots = $derived(step.units ?? []);

	function keyFor(label: string): string {
		const base =
			label
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, '_')
				.replace(/^_+|_+$/g, '')
				.slice(0, 60) || 'unit';
		const taken = new Set(au.unitSlots().map((s) => s.key));
		let key = base;
		for (let n = 2; taken.has(key); n++) key = `${base}_${n}`;
		return key;
	}

	type Slot = UnitSlot & { partNumber?: string; partName?: string };
	const save = (next: Slot[]) => au.edit(step, { units: next });

	function add(p: PartHit | null) {
		if (!p) return;
		save([
			...slots,
			{
				key: keyFor(p.name),
				label: p.name,
				partId: p.id,
				required: false,
				partNumber: p.internal_pn ?? '',
				partName: p.name
			}
		]);
	}

	const patch = (key: string, change: Partial<Slot>) =>
		save(slots.map((s) => (s.key === key ? { ...s, ...change } : s)));
</script>

<div class="grid grid-cols-1 gap-1.5" data-unit-slots-editor={step.order}>
	<div class="flex items-center gap-2">
		<span class="label">Units</span>
		<PartPicker meta="tracking_type" onselect={add}>
			{#snippet trigger({ props })}
				<Button {...props} size="sm" variant="outline">+ UNIT</Button>
			{/snippet}
		</PartPicker>
	</div>
	{#if slots.length}
		<table class="w-full border-collapse text-xs">
			<thead>
				<tr class="border-b border-border bg-muted/60 text-left">
					{#each ['LABEL', 'PART', 'REQUIRED', ''] as h (h)}
						<th class="h-7 px-2 font-mono text-xs font-medium tracking-wider text-muted-foreground"
							>{h}</th
						>
					{/each}
				</tr>
			</thead>
			<tbody>
				{#each slots as s (s.key)}
					<tr class="border-b border-border">
						<td class="px-2 py-1">
							<Input
								class="h-7 min-w-40"
								aria-label={`Label of ${s.label}`}
								value={s.label}
								onkeydown={(e) => e.stopPropagation()}
								onchange={(e) => {
									const label = e.currentTarget.value.trim();
									if (label) patch(s.key, { label });
								}}
							/>
						</td>
						<td class="px-2 py-1">
							<span class="font-mono">{s.partNumber ?? ''}</span>
							<span>{s.partName ?? ''}</span>
							<PartPicker
								meta="tracking_type"
								onselect={(p: PartHit | null) =>
									p &&
									patch(s.key, { partId: p.id, partNumber: p.internal_pn ?? '', partName: p.name })}
							>
								{#snippet trigger({ props })}
									<button
										{...props}
										type="button"
										class="ml-2 font-mono text-xs text-info hover:underline">CHANGE</button
									>
								{/snippet}
							</PartPicker>
						</td>
						<td class="px-2 py-1">
							<Checkbox
								aria-label={`${s.label} is required`}
								checked={s.required}
								onCheckedChange={(v) => patch(s.key, { required: !!v })}
							/>
						</td>
						<td class="px-2 py-1 text-right">
							<ActionLink
								aria-label={`Remove ${s.label}`}
								onclick={() => save(slots.filter((x) => x.key !== s.key))}>REMOVE</ActionLink
							>
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{:else}
		<span class="font-mono text-xs text-muted-foreground">none</span>
	{/if}
</div>
