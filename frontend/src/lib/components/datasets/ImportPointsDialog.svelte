<script lang="ts">
	import { opal } from '#lib/api.js';
	import { toast, toastError, ErrorBanner } from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';

	let {
		open = $bindable(false),
		datasetId,
		onimported
	}: {
		open: boolean;
		datasetId: number;
		onimported: () => void | Promise<void>;
	} = $props();

	let csv = $state('');
	let busy = $state(false);
	let error = $state<string | null>(null);

	$effect(() => {
		if (open) {
			csv = '';
			error = null;
		}
	});

	async function pick(e: Event & { currentTarget: HTMLInputElement }) {
		const file = e.currentTarget.files?.[0];
		if (file) csv = await file.text();
	}

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		error = null;
		try {
			const r = await opal.datasets.points.import({ id: datasetId, csv });
			toast.success(`Imported ${r.imported} ${r.imported === 1 ? 'point' : 'points'}`);
			open = false;
			await onimported();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Import failed';
			toastError(err);
		} finally {
			busy = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="max-w-xl">
		<Dialog.Header><Dialog.Title>Import data points</Dialog.Title></Dialog.Header>
		<form class="grid grid-cols-1 gap-3" onsubmit={submit}>
			<div class="grid grid-cols-1 gap-1.5">
				<Label for="imp-file">CSV file</Label>
				<input id="imp-file" type="file" accept=".csv,text/csv" onchange={pick} class="text-sm" />
			</div>
			<div class="grid grid-cols-1 gap-1.5">
				<Label for="imp-csv">CSV</Label>
				<Textarea
					id="imp-csv"
					bind:value={csv}
					rows={8}
					class="font-mono text-xs"
					placeholder="recorded_at,field,..."
				/>
			</div>
			<ErrorBanner message={error} />
			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={() => (open = false)}>CANCEL</Button>
				<Button type="submit" disabled={busy || !csv.trim()}>IMPORT</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
