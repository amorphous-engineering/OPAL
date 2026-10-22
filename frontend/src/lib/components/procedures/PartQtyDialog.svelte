<script lang="ts">
	// Pick a part (search by name or number) and a quantity. Used for kit and output lines.
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { api } from '#lib/api.js';
	import { toastError } from '#lib/components/opal/index.js';
	import { State } from '#lib/components/opal/index.js';

	interface PartHit {
		id: number;
		internal_pn: string | null;
		name: string;
		unit_of_measure: string;
		lifecycle_state: string;
	}

	let {
		open = $bindable(false),
		title,
		qtyLabel,
		exclude = [],
		onsubmit
	}: {
		open: boolean;
		title: string;
		qtyLabel: string;
		exclude?: number[];
		onsubmit: (partId: number, quantity: number) => Promise<void>;
	} = $props();

	let query = $state('');
	let hits = $state<PartHit[]>([]);
	let chosen = $state<PartHit | null>(null);
	let quantity = $state('1');
	let busy = $state(false);
	let searching = $state(false);
	let timer: ReturnType<typeof setTimeout> | undefined;

	$effect(() => {
		if (open) {
			query = '';
			hits = [];
			chosen = null;
			quantity = '1';
			search('');
		}
	});

	async function search(q: string) {
		searching = true;
		try {
			const r = await api.get<{ items: PartHit[] }>('/parts', { search: q, limit: 8 });
			hits = r.items.filter((p) => !exclude.includes(p.id));
		} catch (e) {
			toastError(e);
		} finally {
			searching = false;
		}
	}

	function onInput() {
		clearTimeout(timer);
		timer = setTimeout(() => search(query), 200);
	}

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		if (!chosen) return;
		busy = true;
		try {
			await onsubmit(chosen.id, Number(quantity));
			open = false;
		} catch (err) {
			toastError(err);
		} finally {
			busy = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header><Dialog.Title>{title}</Dialog.Title></Dialog.Header>
		<form class="grid gap-3" onsubmit={submit}>
			{#if chosen}
				<div class="grid gap-1.5">
					<span class="label">Part</span>
					<div class="flex items-center gap-2 border border-border px-2 py-1.5 text-xs">
						<span class="font-mono text-info">{chosen.internal_pn ?? '—'}</span>
						<span class="truncate">{chosen.name}</span>
						<button
							type="button"
							class="ml-auto font-mono text-[11px] text-info hover:underline"
							onclick={() => (chosen = null)}>CHANGE</button
						>
					</div>
				</div>
				<div class="grid gap-1.5">
					<Label for="part-qty">{qtyLabel}</Label>
					<Input
						id="part-qty"
						type="number"
						step="any"
						min="0"
						bind:value={quantity}
						required
						class="font-mono"
					/>
				</div>
			{:else}
				<div class="grid gap-1.5">
					<Label for="part-search">Part</Label>
					<Input
						id="part-search"
						placeholder="Search by name or number"
						autocomplete="off"
						bind:value={query}
						oninput={onInput}
					/>
				</div>
				<ul class="max-h-56 overflow-y-auto border border-border" aria-label="Matching parts">
					{#each hits as p (p.id)}
						<li class="border-b border-border last:border-b-0">
							<button
								type="button"
								class="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs hover:bg-accent"
								onclick={() => (chosen = p)}
							>
								<span class="w-24 shrink-0 font-mono text-info">{p.internal_pn ?? '—'}</span>
								<span class="truncate">{p.name}</span>
								{#if p.lifecycle_state === 'draft'}<State value="draft" class="ml-auto" />{/if}
							</button>
						</li>
					{:else}
						<li class="px-2 py-1.5 font-mono text-xs text-muted-foreground">
							{searching ? '…' : 'PARTS — none'}
						</li>
					{/each}
				</ul>
			{/if}
			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={() => (open = false)}>CANCEL</Button>
				<Button type="submit" disabled={busy || !chosen || !(Number(quantity) > 0)}>ADD</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
