<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import {
		PageHeader,
		Section,
		DataTable,
		DetailTable,
		DetailRow,
		EmptyLine,
		State,
		Timestamp,
		confirm,
		toastError,
		type Column
	} from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { opal } from '#lib/api.js';
	import { money } from '#lib/format.js';
	import EditableRow from '#lib/components/purchasing/EditableRow.svelte';
	import SupplierCatalog from '#lib/components/purchasing/SupplierCatalog.svelte';
	import type { PurchaseListItem } from '#lib/components/purchasing/types.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const s = $derived(data.supplier);

	async function patch(body: Record<string, unknown>) {
		await opal.purchasing.suppliers.update({ id: s.id, ...body });
		await invalidateAll();
	}

	async function remove() {
		const ok = await confirm({
			title: `Delete ${s.name}`,
			body: 'The supplier and its catalog numbers are removed. Suppliers with purchase orders cannot be deleted; set them inactive instead.',
			action: 'DELETE',
			destructive: true
		});
		if (!ok) return;
		try {
			await opal.purchasing.suppliers.delete({ id: s.id });
			await goto('/suppliers');
		} catch (e) {
			toastError(e);
		}
	}

	const poColumns: Column<PurchaseListItem>[] = [
		{ key: 'reference', label: 'Reference', mono: true },
		{ key: 'status', label: 'Status' },
		{ key: 'orderedAt', label: 'Ordered' },
		{ key: 'targetDate', label: 'Target', mono: true },
		{ key: 'lines', label: 'Lines received', align: 'right', mono: true },
		{ key: 'totalCost', label: 'Total', align: 'right', mono: true }
	];
</script>

<PageHeader
	title={s.name}
	identifier={s.code}
	crumbs={[{ label: 'Suppliers', href: '/suppliers' }, { label: s.name }]}
>
	{#snippet state()}
		{#if !s.isActive}<State value="inactive" tone="muted" badge />{/if}
	{/snippet}
	{#snippet actions()}
		<Button href={`/purchases/new?supplier_id=${s.id}`}>+ NEW PURCHASE</Button>
		{#if s.deletable}
			<Button variant="destructive" onclick={remove}>DELETE</Button>
		{/if}
	{/snippet}
</PageHeader>

<div class="grid grid-cols-1 gap-4 p-4 xl:grid-cols-[minmax(0,34rem)_minmax(0,1fr)]">
	<Section title="SUPPLIER" class="content-start">
		<DetailTable>
			<EditableRow
				label="Name"
				value={s.name}
				required
				maxlength={255}
				onsave={(v) => patch({ name: v })}
			/>
			<EditableRow
				label="Code"
				mono
				value={s.code}
				maxlength={50}
				onsave={(v) => patch({ code: v })}
			/>
			<EditableRow
				label="Status"
				type="select"
				value={s.isActive ? 'true' : 'false'}
				options={[
					{ value: 'true', label: 'ACTIVE' },
					{ value: 'false', label: 'INACTIVE' }
				]}
				onsave={(v) => patch({ isActive: v === 'true' })}
			>
				{#snippet display()}
					<State
						value={s.isActive ? 'active' : 'inactive'}
						tone={s.isActive ? 'default' : 'muted'}
					/>
				{/snippet}
			</EditableRow>
			<EditableRow
				label="Email"
				type="email"
				value={s.email}
				maxlength={255}
				onsave={(v) => patch({ email: v })}
			>
				{#snippet display()}
					{#if s.email}<a href={`mailto:${s.email}`} class="text-info hover:underline">{s.email}</a
						>{:else}<span class="text-muted-foreground">—</span>{/if}
				{/snippet}
			</EditableRow>
			<EditableRow
				label="Phone"
				type="tel"
				mono
				value={s.phone}
				maxlength={50}
				onsave={(v) => patch({ phone: v })}
			/>
			<EditableRow
				label="Website"
				type="url"
				value={s.website}
				maxlength={255}
				placeholder="https://"
				onsave={(v) => patch({ website: v })}
			>
				{#snippet display()}
					{#if s.website}<a
							href={s.website}
							target="_blank"
							rel="noopener noreferrer"
							class="break-all text-info hover:underline">{s.website}</a
						>{:else}<span class="text-muted-foreground">—</span>{/if}
				{/snippet}
			</EditableRow>
			<EditableRow
				label="Address"
				type="textarea"
				value={s.address}
				onsave={(v) => patch({ address: v })}
			/>
			<EditableRow
				label="Description"
				type="textarea"
				value={s.description}
				onsave={(v) => patch({ description: v })}
			/>
			<EditableRow
				label="Notes"
				type="textarea"
				value={s.notes}
				onsave={(v) => patch({ notes: v })}
			/>
			<DetailRow label="Created"><Timestamp value={s.createdAt} /></DetailRow>
			<DetailRow label="Updated"><Timestamp value={s.updatedAt} /></DetailRow>
		</DetailTable>
	</Section>

	<div class="grid min-w-0 grid-cols-1 content-start gap-4">
		{#if data.purchases.length === 0}
			<EmptyLine label="Purchase orders" />
		{:else}
			<Section title="PURCHASE ORDERS" count={data.purchases.length}>
				<DataTable
					rows={data.purchases}
					columns={poColumns}
					href={(r) => `/purchases/${r.id}`}
					key={(r) => r.id}
					emptyLabel="Purchase orders"
				>
					{#snippet cell(r, col)}
						{#if col.key === 'reference'}
							<span class="text-info">{r.reference ?? '—'}</span>
						{:else if col.key === 'status'}
							<State value={r.status} />
							{#if r.isOverdue}<State value="overdue" tone="error" badge class="ml-2" />{/if}
						{:else if col.key === 'orderedAt'}
							<Timestamp value={r.orderedAt} dateOnly />
						{:else if col.key === 'targetDate'}
							{#if r.targetDate}<span class={r.isOverdue ? 'text-error' : ''}>{r.targetDate}</span
								>{:else}<span class="text-muted-foreground">—</span>{/if}
						{:else if col.key === 'lines'}
							{#if r.totalLines === 0}<span class="text-muted-foreground">—</span
								>{:else}{r.linesComplete}/{r.totalLines}{/if}
						{:else if col.key === 'totalCost'}
							{money(r.totalCost)}
						{/if}
					{/snippet}
				</DataTable>
			</Section>
		{/if}
	</div>
</div>

<div class="px-4 pb-4">
	<SupplierCatalog supplierId={s.id} entries={data.parts} onchanged={() => invalidateAll()} />
</div>
