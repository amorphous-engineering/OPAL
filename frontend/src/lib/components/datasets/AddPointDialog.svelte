<script lang="ts">
	import { fromInput } from '#lib/format.js';
	import { opal } from '#lib/api.js';
	import { toastError, ErrorBanner } from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import { specResult, specText, unitSymbol, type PointValues } from '@opal/shared';
	import { Badge } from '#lib/components/ui/badge/index.js';
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

	let recordedAt = $state('');
	let inputs = $state<Record<string, string>>({});
	let busy = $state(false);
	let error = $state<string | null>(null);

	$effect(() => {
		if (open) {
			inputs = {};
			recordedAt = '';
			error = null;
		}
	});

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		const values: PointValues = {};
		for (const f of fields) {
			// A number input binds a number, or null once it is cleared.
			const raw: string | number | null | undefined = inputs[f.name];
			if (raw === undefined || raw === null || raw === '') continue;
			values[f.name] =
				f.type === 'number' ? Number(raw) : f.type === 'boolean' ? raw === 'true' : String(raw);
		}
		if (Object.keys(values).length === 0) return (error = 'Enter at least one value');
		busy = true;
		error = null;
		try {
			await opal.datasets.points.add({
				id: datasetId,
				values,
				// A datetime-local value is local time; send it as an ISO instant.
				recordedAt: recordedAt ? fromInput(recordedAt) : undefined
			});
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
			<div class="grid grid-cols-1 gap-1.5">
				<Label for="pt-recorded-at">Recorded</Label>
				<Input id="pt-recorded-at" type="datetime-local" bind:value={recordedAt} />
			</div>
			{#each fields as f (f.name)}
				<div class="grid grid-cols-1 gap-1.5">
					<Label for={`pt-${f.name}`}>{f.name}{f.unit ? ` (${unitSymbol(f.unit)})` : ''}</Label>
					{#if f.type === 'boolean'}
						<NativeSelect id={`pt-${f.name}`} bind:value={inputs[f.name]}>
							<NativeSelectOption value="">—</NativeSelectOption>
							<NativeSelectOption value="true">Yes</NativeSelectOption>
							<NativeSelectOption value="false">No</NativeSelectOption>
						</NativeSelect>
					{:else if f.type === 'number'}
						<Input id={`pt-${f.name}`} type="number" step="any" bind:value={inputs[f.name]} />
						{#if f.spec}
							<p class="flex items-center gap-2 font-mono text-xs text-muted-foreground">
								Spec {specText(f.spec, f.unit)}
								{#if specResult(f.spec, inputs[f.name]) === 'out_of_spec'}
									<Badge
										variant="outline"
										class="border-error/50 bg-error-muted font-mono tracking-wider text-error"
										>OUT OF SPEC</Badge
									>
								{/if}
							</p>
						{/if}
					{:else if f.type === 'date'}
						<Input id={`pt-${f.name}`} type="datetime-local" bind:value={inputs[f.name]} />
					{:else}
						<Input id={`pt-${f.name}`} bind:value={inputs[f.name]} />
					{/if}
				</div>
			{/each}
			<ErrorBanner message={error} />
			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={() => (open = false)}>CANCEL</Button>
				<Button type="submit" disabled={busy}>ADD</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
