<script lang="ts">
	// Template-level files (drawings, datasheets, PDFs): attachments with kind "reference".
	import { Button } from '#lib/components/ui/button/index.js';
	import { api, opal } from '#lib/api.js';
	import {
		DataTable,
		EmptyLine,
		Section,
		Timestamp,
		confirm,
		toastError
	} from '#lib/components/opal/index.js';
	import type { Column } from '#lib/components/opal/index.js';
	import type { Attachment } from '@opal/shared';

	let {
		procedureId,
		docs,
		onchange,
		compact = false
	}: {
		procedureId: number;
		docs: Attachment[];
		onchange: () => void | Promise<void>;
		/** A narrow column: one line per file instead of a table. */
		compact?: boolean;
	} = $props();

	let input: HTMLInputElement | undefined = $state();
	let busy = $state(false);

	const columns: Column<Attachment>[] = [
		{ key: 'filename', label: 'File' },
		{ key: 'mimeType', label: 'Type', width: '12rem', mono: true },
		{ key: 'sizeBytes', label: 'Size', width: '6rem', align: 'right', mono: true },
		{ key: 'createdAt', label: 'Uploaded', width: '10rem' },
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
			fd.append('ownerType', 'procedure');
			fd.append('ownerId', String(procedureId));
			fd.append('kind', 'reference');
			await api.post('/attachments', fd);
			await onchange();
		} catch (e) {
			toastError(e);
		} finally {
			busy = false;
			if (input) input.value = '';
		}
	}

	async function remove(d: Attachment) {
		const ok = await confirm({
			title: `Delete ${d.filename}?`,
			body: 'The file is permanently removed from this template.',
			action: 'DELETE',
			destructive: true
		});
		if (!ok) return;
		try {
			await opal.platform.attachments.delete({ id: d.id });
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
		{#if compact}
			<ul class="m-0 list-none p-0">
				{#each docs as d (d.id)}
					<li
						class="flex items-center gap-2 border-b border-border px-3 py-1 text-xs last:border-b-0"
					>
						<a
							href={`/api/attachments/${d.id}/download`}
							target="_blank"
							rel="noreferrer"
							class="min-w-0 flex-1 truncate font-mono text-info hover:underline"
							title={d.filename}>{d.filename}</a
						>
						<span class="font-mono text-muted-foreground">{size(d.sizeBytes)}</span>
						<button
							type="button"
							class="font-mono text-muted-foreground hover:text-error"
							aria-label={`Delete ${d.filename}`}
							onclick={() => remove(d)}>×</button
						>
					</li>
				{/each}
			</ul>
		{:else}
			<DataTable rows={docs} {columns} emptyLabel="Reference documents" dense key={(d) => d.id}>
				{#snippet cell(d, col)}
					{#if col.key === 'filename'}
						<a
							href={`/api/attachments/${d.id}/download`}
							target="_blank"
							rel="noreferrer"
							class="text-info hover:underline">{d.filename}</a
						>
					{:else if col.key === 'sizeBytes'}
						{size(d.sizeBytes)}
					{:else if col.key === 'createdAt'}
						<Timestamp value={d.createdAt} />
					{:else if col.key === 'actions'}
						<button
							type="button"
							class="font-mono text-xs text-muted-foreground hover:text-error"
							onclick={() => remove(d)}>DELETE</button
						>
					{:else if col.key === 'mimeType'}
						{d.mimeType}
					{/if}
				{/snippet}
			</DataTable>
		{/if}
	</Section>
{/if}
