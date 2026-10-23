<script lang="ts">
	import { api } from '#lib/api.js';
	import { toastError } from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import type { SchemaField } from './types.js';

	let {
		open = $bindable(false),
		datasetId,
		fields,
		onadded
	}: {
		open: boolean;
		datasetId: number;
		fields: SchemaField[];
		onadded: () => void | Promise<void>;
	} = $props();

	let inputs = $state<Record<string, string>>({});
	let busy = $state(false);
	let error = $state<string | null>(null);

	$effect(() => {
		if (open) {
			inputs = {};
			error = null;
		}
	});

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		const values: Record<string, unknown> = {};
		for (const f of fields) {
			const raw = inputs[f.name];
			if (raw === undefined || raw === '') continue;
			values[f.name] =
				f.type === 'number' ? Number(raw) : f.type === 'boolean' ? raw === 'true' : raw;
		}
		if (Object.keys(values).length === 0) return (error = 'Enter at least one value');
		busy = true;
		error = null;
		try {
			await api.post(`/datasets/${datasetId}/points`, { values });
			open = false;
			await onadded();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to add point';
			toastError(err);
		} finally {
			busy = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="max-w-md">
		<Dialog.Header><Dialog.Title>Add data point</Dialog.Title></Dialog.Header>
		<form class="grid grid-cols-1 gap-3" onsubmit={submit}>
			{#each fields as f (f.name)}
				<div class="grid grid-cols-1 gap-1.5">
					<Label for={`pt-${f.name}`}>{f.name}{f.unit ? ` (${f.unit})` : ''}</Label>
					{#if f.type === 'boolean'}
						<NativeSelect id={`pt-${f.name}`} bind:value={inputs[f.name]}>
							<NativeSelectOption value="">—</NativeSelectOption>
							<NativeSelectOption value="true">Yes</NativeSelectOption>
							<NativeSelectOption value="false">No</NativeSelectOption>
						</NativeSelect>
					{:else if f.type === 'number'}
						<Input id={`pt-${f.name}`} type="number" step="any" bind:value={inputs[f.name]} />
					{:else if f.type === 'date'}
						<Input id={`pt-${f.name}`} type="datetime-local" bind:value={inputs[f.name]} />
					{:else}
						<Input id={`pt-${f.name}`} bind:value={inputs[f.name]} />
					{/if}
				</div>
			{/each}
			{#if error}
				<p
					role="alert"
					class="rounded-md border border-error/40 bg-error-muted px-2 py-1.5 text-xs text-error"
				>
					{error}
				</p>
			{/if}
			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={() => (open = false)}>CANCEL</Button>
				<Button type="submit" disabled={busy}>ADD</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
