<script lang="ts">
	// Pick a part and a quantity. Used for kit and output lines.
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { toastError } from '#lib/components/opal/index.js';
	import PartPicker from '#lib/components/parts/PartPicker.svelte';
	import type { PartRef } from '#lib/components/parts/types.js';

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

	let chosen = $state<PartRef | null>(null);
	let quantity = $state('1');
	let busy = $state(false);

	$effect(() => {
		if (open) {
			chosen = null;
			quantity = '1';
		}
	});

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
		<form class="grid grid-cols-1 gap-3" onsubmit={submit}>
			<div class="grid grid-cols-1 gap-1.5">
				<Label for="part-pick">Part</Label>
				<PartPicker id="part-pick" bind:value={chosen} {exclude} />
			</div>
			<div class="grid grid-cols-1 gap-1.5">
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
			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={() => (open = false)}>CANCEL</Button>
				<Button type="submit" disabled={busy || !chosen || !(Number(quantity) > 0)}>ADD</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
