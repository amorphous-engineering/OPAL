<script lang="ts">
	// Step parts as a table: quantity, usage and notes edit in place; a part
	// picker adds a line. Consume lines are drawn from stock at execution;
	// tooling is recorded, not deducted.
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { NativeSelect } from '#lib/components/ui/native-select/index.js';
	import PartPicker from '#lib/components/parts/PartPicker.svelte';
	import { useDoc, type PartHit } from '../controller.js';
	import type { DocStep } from '../types.js';

	let { step }: { step: DocStep } = $props();
	const au = useDoc().author!;

	let adding = $state(false);
	let chosen = $state<PartHit | null>(null);
	let qty = $state('1');
	let usage = $state('consume');
	let notes = $state('');

	const taken = $derived(new Set(step.step_kit.map((k) => k.part_id)));

	function open(p: PartHit | null) {
		if (!p) return;
		adding = true;
		chosen = p;
		qty = '1';
		usage = 'consume';
		notes = '';
	}

	async function add(e: Event) {
		e.preventDefault();
		if (!chosen || !(Number(qty) > 0)) return;
		await au.addKit(step, chosen, Number(qty), usage, notes.trim() || null);
		adding = false;
	}
</script>

<div class="grid grid-cols-1 gap-1.5" data-step-kit-editor={step.order}>
	<div class="flex items-center gap-2">
		<span class="label">Step parts</span>
		{#if !adding}
			<PartPicker exclude={[...taken]} onselect={open}>
				{#snippet trigger({ props })}
					<Button {...props} size="xs" variant="outline">+ PART</Button>
				{/snippet}
			</PartPicker>
		{/if}
	</div>
	{#if step.step_kit.length}
		<table class="w-full border-collapse text-xs">
			<thead>
				<tr class="border-b border-border bg-muted/60 text-left">
					{#each ['PN', 'NAME', 'REQ', 'TYPE', 'NOTES', ''] as h (h)}
						<th class="h-7 px-2 font-mono text-xs font-medium tracking-wider text-muted-foreground"
							>{h}</th
						>
					{/each}
				</tr>
			</thead>
			<tbody>
				{#each step.step_kit as k (k.id)}
					<tr class="border-b border-border">
						<td class="px-2 py-1 whitespace-nowrap"
							><a class="font-mono text-info hover:underline" href={`/parts/${k.part_id}`}
								>{k.part_number ?? '—'}</a
							></td
						>
						<td class="px-2 py-1">{k.part_name}</td>
						<td class="px-2 py-1">
							<Input
								type="number"
								min="0"
								step="any"
								class="h-7 w-24 font-mono"
								aria-label={`Quantity of ${k.part_name}`}
								aria-invalid={!(k.quantity_required > 0)}
								value={k.quantity_required}
								onkeydown={(e) => e.stopPropagation()}
								oninput={(e) => {
									const v = Number(e.currentTarget.value);
									au.editKit(step, k.id!, { quantity_required: v });
								}}
							/>
						</td>
						<td class="px-2 py-1">
							<NativeSelect
								size="sm"
								aria-label={`Usage of ${k.part_name}`}
								value={k.usage_type}
								onchange={(e) => au.editKit(step, k.id!, { usage_type: e.currentTarget.value })}
							>
								<option value="consume">CONSUME</option>
								<option value="tooling">TOOLING</option>
							</NativeSelect>
						</td>
						<td class="px-2 py-1">
							<Input
								class="h-7 min-w-40"
								aria-label={`Notes for ${k.part_name}`}
								value={k.notes ?? ''}
								onkeydown={(e) => e.stopPropagation()}
								oninput={(e) => au.editKit(step, k.id!, { notes: e.currentTarget.value })}
							/>
						</td>
						<td class="px-2 py-1 text-right">
							<Button
								size="xs"
								variant="ghost"
								aria-label={`Remove ${k.part_name}`}
								onclick={() => au.removeKit(step, k.id!)}>REMOVE</Button
							>
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}
	{#if adding && chosen}
		<form
			class="grid grid-cols-1 gap-2 rounded-md border border-border bg-muted/30 p-2"
			onsubmit={add}
		>
			<div class="flex flex-wrap items-center gap-2 text-xs">
				<span class="font-mono text-info">{chosen.internal_pn ?? '—'}</span>
				<span class="min-w-0 truncate">{chosen.name}</span>
				<PartPicker exclude={[...taken]} onselect={(p: PartHit | null) => p && (chosen = p)}>
					{#snippet trigger({ props })}
						<button {...props} type="button" class="font-mono text-xs text-info hover:underline"
							>CHANGE</button
						>
					{/snippet}
				</PartPicker>
				<Input
					type="number"
					min="0"
					step="any"
					class="ml-auto h-7 w-24 font-mono"
					aria-label="Quantity"
					bind:value={qty}
					required
				/>
				<NativeSelect size="sm" aria-label="Usage" bind:value={usage}>
					<option value="consume">CONSUME</option>
					<option value="tooling">TOOLING</option>
				</NativeSelect>
				<Input class="h-7 w-48" aria-label="Notes" placeholder="Notes" bind:value={notes} />
				<Button type="submit" size="xs" disabled={!(Number(qty) > 0)}>ADD</Button>
				<Button type="button" size="xs" variant="outline" onclick={() => (adding = false)}
					>CANCEL</Button
				>
			</div>
		</form>
	{:else if !step.step_kit.length}
		<span class="font-mono text-xs text-muted-foreground">none</span>
	{/if}
</div>
