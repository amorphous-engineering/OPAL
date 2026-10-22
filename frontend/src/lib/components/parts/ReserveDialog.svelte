<script lang="ts">
	// Reserve a block of part numbers as draft parts (label pre-printing,
	// vendor pre-allocation). Stale drafts stay visible and deletable.
	import { goto } from '$app/navigation';
	import { toast, toastError } from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import { api } from '#lib/api.js';
	import FormField from './FormField.svelte';
	import type { SchemaTier } from './types.js';

	let { tiers, open = $bindable(false) }: { tiers: SchemaTier[]; open?: boolean } = $props();

	let tier = $state('');
	let count = $state('10');
	let prefix = $state('');
	let busy = $state(false);

	async function reserve(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		try {
			const r = await api.post<{ first_pn: string; last_pn: string; parts: unknown[] }>(
				'/parts/reserve',
				{ tier: Number(tier), count: Number(count), name_prefix: prefix.trim() || null }
			);
			toast.success(`Reserved ${r.parts.length}: ${r.first_pn} – ${r.last_pn}`);
			open = false;
			await goto('/parts?state=draft', { invalidateAll: true });
		} catch (err) {
			toastError(err);
		} finally {
			busy = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="max-w-md">
		<Dialog.Header>
			<Dialog.Title>Reserve part numbers</Dialog.Title>
		</Dialog.Header>
		<form class="grid gap-3" onsubmit={reserve}>
			<FormField label="Tier" for="rv-tier" required>
				<NativeSelect.Root id="rv-tier" size="sm" class="w-full" bind:value={tier} required>
					<NativeSelect.Option value="">Select tier</NativeSelect.Option>
					{#each tiers as t (t.level)}
						<NativeSelect.Option value={String(t.level)}
							>T{t.level} {t.name.toUpperCase()}</NativeSelect.Option
						>
					{/each}
				</NativeSelect.Root>
			</FormField>
			<div class="grid grid-cols-2 gap-3">
				<FormField label="Count (1–500)" for="rv-count" required>
					<Input id="rv-count" type="number" min="1" max="500" bind:value={count} required />
				</FormField>
				<FormField label="Name prefix" for="rv-prefix">
					<Input id="rv-prefix" placeholder="RESERVED" bind:value={prefix} />
				</FormField>
			</div>
			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={() => (open = false)}>CANCEL</Button>
				<Button type="submit" disabled={busy || !tier}>RESERVE</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
