<script lang="ts">
	// Quotes, invoices and packing slips attached to the order.
	import {
		ActionLink,
		Section,
		EmptyLine,
		Timestamp,
		confirm,
		toastError
	} from '#lib/components/opal/index.js';
	import { NativeSelect } from '#lib/components/ui/native-select/index.js';
	import { api } from '#lib/api.js';
	import type { Attachment } from './types.js';

	let {
		purchaseId,
		attachments,
		onchanged
	}: {
		purchaseId: number;
		attachments: Attachment[];
		onchanged: () => void | Promise<void>;
	} = $props();

	const KINDS = [
		{ value: 'quote', label: 'QUOTE' },
		{ value: 'invoice', label: 'INVOICE' },
		{ value: 'packing_slip', label: 'PACKING SLIP' },
		{ value: 'reference', label: 'OTHER' }
	];
	let kind = $state('quote');
	let input = $state<HTMLInputElement | null>(null);
	let busy = $state(false);

	function size(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
	}

	async function upload() {
		const file = input?.files?.[0];
		if (!file) return;
		busy = true;
		try {
			const body = new FormData();
			body.set('file', file);
			body.set('purchase_id', String(purchaseId));
			body.set('kind', kind);
			await api.post('/attachments/upload', body);
			await onchanged();
		} catch (err) {
			toastError(err);
		} finally {
			busy = false;
			if (input) input.value = '';
		}
	}

	async function remove(a: Attachment) {
		const ok = await confirm({
			title: `Delete ${a.original_filename}`,
			body: 'The file is removed from the order and from disk.',
			action: 'DELETE',
			destructive: true
		});
		if (!ok) return;
		try {
			await api.del(`/attachments/${a.id}`);
			await onchanged();
		} catch (err) {
			toastError(err);
		}
	}
</script>

<input
	bind:this={input}
	type="file"
	class="hidden"
	onchange={upload}
	accept="application/pdf,image/*,text/plain,text/csv"
/>

{#snippet picker()}
	<NativeSelect size="sm" bind:value={kind} aria-label="Document kind" class="w-36">
		{#each KINDS as k (k.value)}<option value={k.value}>{k.label}</option>{/each}
	</NativeSelect>
	<ActionLink disabled={busy} onclick={() => input?.click()}>+ UPLOAD</ActionLink>
{/snippet}

{#if attachments.length === 0}
	<EmptyLine label="Attachments">
		{#snippet action()}
			<span class="inline-flex items-center gap-1">{@render picker()}</span>
		{/snippet}
	</EmptyLine>
{:else}
	<Section title="ATTACHMENTS" count={attachments.length}>
		{#snippet actions()}{@render picker()}{/snippet}
		<table class="w-full border-collapse text-sm">
			<thead>
				<tr class="border-b border-border bg-muted/60">
					{#each ['FILE', 'KIND', 'SIZE', 'UPLOADED', ''] as h (h)}
						<th
							scope="col"
							class="h-8 px-3 text-left font-mono text-[11px] font-medium tracking-wider whitespace-nowrap text-muted-foreground uppercase"
							>{h}</th
						>
					{/each}
				</tr>
			</thead>
			<tbody>
				{#each attachments as a (a.id)}
					<tr class="border-b border-border">
						<td class="px-3 py-1.5"
							><a
								href={`/api/attachments/${a.id}/download`}
								class="text-info hover:underline"
								download>{a.original_filename}</a
							></td
						>
						<td class="px-3 py-1.5 font-mono text-xs uppercase"
							>{(a.kind ?? '').replace(/_/g, ' ') || '—'}</td
						>
						<td class="px-3 py-1.5 font-mono text-xs tabular-nums">{size(a.size_bytes)}</td>
						<td class="px-3 py-1.5"
							><Timestamp value={a.created_at} />
							{#if a.uploaded_by_name}<span class="ml-2 text-muted-foreground"
									>{a.uploaded_by_name}</span
								>{/if}</td
						>
						<td class="px-3 py-1.5 text-right"
							><ActionLink danger onclick={() => remove(a)}>DELETE</ActionLink></td
						>
					</tr>
				{/each}
			</tbody>
		</table>
	</Section>
{/if}
