<script lang="ts">
	// Step parts as a table: quantity, usage and notes edit in place; a part
	// picker adds a line. Consume lines are drawn from stock at execution;
	// tooling is recorded, not deducted.
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { NativeSelect } from '#lib/components/ui/native-select/index.js';
	import { toastError } from '#lib/components/opal/index.js';
	import { useDoc, type PartHit } from '../controller.js';
	import type { DocStep } from '../types.js';

	let { step }: { step: DocStep } = $props();
	const au = useDoc().author!;

	let adding = $state(false);
	let query = $state('');
	let hits = $state<PartHit[]>([]);
	let chosen = $state<PartHit | null>(null);
	let qty = $state('1');
	let usage = $state('consume');
	let notes = $state('');
	let searching = $state(false);
	let timer: ReturnType<typeof setTimeout> | undefined;
	let queryEl = $state<HTMLInputElement | null>(null);

	const taken = $derived(new Set(step.step_kit.map((k) => k.part_id)));

	async function search(q: string) {
		searching = true;
		try {
			hits = (await au.searchParts(q)).filter((p) => !taken.has(p.id));
		} catch (e) {
			toastError(e);
		} finally {
			searching = false;
		}
	}

	function open() {
		adding = true;
		query = '';
		chosen = null;
		qty = '1';
		usage = 'consume';
		notes = '';
		search('');
		setTimeout(() => queryEl?.focus(), 30);
	}

	function onQuery() {
		clearTimeout(timer);
		timer = setTimeout(() => search(query), 200);
	}

	async function add(e: Event) {
		e.preventDefault();
		if (!chosen || !(Number(qty) > 0)) return;
		await au.addKit(step, chosen, Number(qty), usage, notes.trim() || null);
		adding = false;
	}
</script>

<div class="grid gap-1.5" data-step-kit-editor={step.order}>
	<div class="flex items-center gap-2">
		<span class="label">Step parts</span>
		{#if !adding}
			<Button size="xs" variant="outline" onclick={open}>+ PART</Button>
		{/if}
	</div>
	{#if step.step_kit.length}
		<table class="w-full border-collapse text-xs">
			<thead>
				<tr class="border-b border-border bg-muted/60 text-left">
					{#each ['PART', 'REQ', 'TYPE', 'NOTES', ''] as h (h)}
						<th
							class="h-7 px-2 font-mono text-[11px] font-medium tracking-wider text-muted-foreground"
							>{h}</th
						>
					{/each}
				</tr>
			</thead>
			<tbody>
				{#each step.step_kit as k (k.id)}
					<tr class="border-b border-border">
						<td class="px-2 py-1"
							><a class="font-mono text-info hover:underline" href={`/parts/${k.part_id}`}
								>{k.part_number ?? '—'}</a
							>
							{k.part_name}</td
						>
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
	{#if adding}
		<form class="grid gap-2 border border-border bg-muted/30 p-2" onsubmit={add}>
			{#if chosen}
				<div class="flex flex-wrap items-center gap-2 text-xs">
					<span class="font-mono text-info">{chosen.internal_pn ?? '—'}</span>
					<span class="min-w-0 truncate">{chosen.name}</span>
					<button
						type="button"
						class="font-mono text-[11px] text-info hover:underline"
						onclick={() => (chosen = null)}>CHANGE</button
					>
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
			{:else}
				<div class="flex items-center gap-2">
					<Input
						bind:ref={queryEl}
						class="h-7 max-w-sm"
						placeholder="Search parts by name or number"
						aria-label="Search parts"
						autocomplete="off"
						bind:value={query}
						oninput={onQuery}
						onkeydown={(e) => {
							e.stopPropagation();
							if (e.key === 'Escape') adding = false;
						}}
					/>
					<Button type="button" size="xs" variant="outline" onclick={() => (adding = false)}
						>CANCEL</Button
					>
				</div>
				<ul class="m-0 max-h-48 list-none overflow-y-auto border border-border bg-background p-0">
					{#each hits as p (p.id)}
						<li class="border-b border-border last:border-b-0">
							<button
								type="button"
								class="flex w-full items-center gap-2 px-2 py-1 text-left text-xs hover:bg-accent"
								onclick={() => (chosen = p)}
							>
								<span class="w-24 shrink-0 font-mono text-info">{p.internal_pn ?? '—'}</span>
								<span class="truncate">{p.name}</span>
							</button>
						</li>
					{:else}
						<li class="px-2 py-1 font-mono text-xs text-muted-foreground">
							{searching ? '…' : 'PARTS — none'}
						</li>
					{/each}
				</ul>
			{/if}
		</form>
	{:else if !step.step_kit.length}
		<span class="font-mono text-xs text-muted-foreground">none</span>
	{/if}
</div>
