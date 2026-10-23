<script lang="ts">
	// Template-level files (drawings, datasheets, PDFs): attachments with kind "reference".
	import { Button } from '#lib/components/ui/button/index.js';
	import { api } from '#lib/api.js';
	import {
		DataTable,
		EmptyLine,
		Section,
		Timestamp,
		confirm,
		toastError
	} from '#lib/components/opal/index.js';
	import type { Column } from '#lib/components/opal/index.js';
	import type { RefDoc } from './types.js';

	let {
		procedureId,
		docs,
		onchange
	}: { procedureId: number; docs: RefDoc[]; onchange: () => void | Promise<void> } = $props();

	let input: HTMLInputElement | undefined = $state();
	let busy = $state(false);

	const columns: Column<RefDoc>[] = [
		{ key: 'original_filename', label: 'File' },
		{ key: 'mime_type', label: 'Type', width: '12rem', mono: true },
		{ key: 'size_bytes', label: 'Size', width: '6rem', align: 'right', mono: true },
		{ key: 'created_at', label: 'Uploaded', width: '10rem' },
		{ key: 'actions', label: '', width: '5rem', align: 'right' }
	];

	function size(n: number): string {
		return n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
	}

	async function upload() {
		const file = input?.files?.[0];
		if (!file) return;
		busy = true;
		try {
			const fd = new FormData();
			fd.append('file', file);
			fd.append('procedure_id', String(procedureId));
			fd.append('kind', 'reference');
			await api.post('/attachments/upload', fd);
			await onchange();
		} catch (e) {
			toastError(e);
		} finally {
			busy = false;
			if (input) input.value = '';
		}
	}

	async function remove(d: RefDoc) {
		const ok = await confirm({
			title: `Delete ${d.original_filename}?`,
			body: 'The file is permanently removed from this template.',
			action: 'DELETE',
			destructive: true
		});
		if (!ok) return;
		try {
			await api.del(`/attachments/${d.id}`);
			await onchange();
		} catch (e) {
			toastError(e);
		}
	}
</script>

<input bind:this={input} type="file" class="hidden" onchange={upload} />

{#if docs.length === 0}
	<EmptyLine label="Reference documents">
		{#snippet action()}
			<button
				type="button"
				class="font-medium text-info hover:underline disabled:opacity-50"
				disabled={busy}
				onclick={() => input?.click()}>+ UPLOAD</button
			>
		{/snippet}
	</EmptyLine>
{:else}
	<Section title="Reference documents" count={docs.length}>
		{#snippet actions()}
			<Button variant="ghost" size="xs" disabled={busy} onclick={() => input?.click()}
				>+ UPLOAD</Button
			>
		{/snippet}
		<DataTable rows={docs} {columns} emptyLabel="Reference documents" dense key={(d) => d.id}>
			{#snippet cell(d, col)}
				{#if col.key === 'original_filename'}
					<a
						href={`/api/attachments/${d.id}/download`}
						target="_blank"
						rel="noreferrer"
						class="text-info hover:underline">{d.original_filename}</a
					>
				{:else if col.key === 'size_bytes'}
					{size(d.size_bytes)}
				{:else if col.key === 'created_at'}
					<Timestamp value={d.created_at} />
				{:else if col.key === 'actions'}
					<button
						type="button"
						class="font-mono text-xs text-muted-foreground hover:text-error"
						onclick={() => remove(d)}>DELETE</button
					>
				{:else}
					{(d as unknown as Record<string, unknown>)[col.key]}
				{/if}
			{/snippet}
		</DataTable>
	</Section>
{/if}
