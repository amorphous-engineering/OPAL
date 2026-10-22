<script lang="ts">
	import { goto } from '$app/navigation';
	import { PageHeader, State, confirm, toastError } from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { api } from '#lib/api.js';
	import { act } from '#lib/components/parts/actions.js';
	import BomSection from '#lib/components/parts/BomSection.svelte';
	import DesignSections from '#lib/components/parts/DesignSections.svelte';
	import HistorySection from '#lib/components/parts/HistorySection.svelte';
	import IdentitySection from '#lib/components/parts/IdentitySection.svelte';
	import StockSection from '#lib/components/parts/StockSection.svelte';
	import SuppliersSection from '#lib/components/parts/SuppliersSection.svelte';
	import UsageSections from '#lib/components/parts/UsageSections.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const detail = $derived(data.detail);
	const part = $derived(detail.part);
	const isDraft = $derived(part.lifecycle_state === 'draft');

	const REFERENCE_NAMES: Record<string, [string, string]> = {
		bom_components: ['BOM component', 'BOM components'],
		used_in_assemblies: ['assembly use', 'assembly uses'],
		kits: ['kit', 'kits'],
		step_kits: ['step kit', 'step kits'],
		requirement_allocations: ['requirement', 'requirements'],
		issues: ['issue', 'issues'],
		procedure_outputs: ['procedure output', 'procedure outputs'],
		supplier_entries: ['supplier', 'suppliers'],
		test_templates: ['test', 'tests'],
		child_parts: ['child part', 'child parts'],
		inventory_records: ['stock record', 'stock records'],
		purchase_lines: ['PO line', 'PO lines']
	};
	const references = $derived(
		Object.entries(detail.references).map(([k, n]) => {
			const [one, many] = REFERENCE_NAMES[k] ?? [k.replace(/_/g, ' '), k.replace(/_/g, ' ')];
			return `${n} ${n === 1 ? one : many}`;
		})
	);

	async function activate() {
		const ok = await confirm({
			title: `Activate ${part.internal_pn}`,
			body: 'Locks the PN and tier permanently.',
			action: 'ACTIVATE'
		});
		if (ok)
			await act(() => api.post(`/parts/${part.id}/activate`, {}), `${part.internal_pn} activated`);
	}

	async function remove() {
		const ok = await confirm({
			title: `Delete ${part.internal_pn}`,
			body: `${part.internal_pn} is retired permanently and never reissued.`,
			action: 'DELETE',
			destructive: true
		});
		if (!ok) return;
		try {
			await api.del(`/parts/${part.id}`);
			await goto('/parts');
		} catch (e) {
			toastError(e);
		}
	}
</script>

<PageHeader
	title={part.name}
	identifier={part.internal_pn}
	crumbs={[{ label: 'Parts', href: '/parts' }, { label: part.internal_pn ?? part.name }]}
>
	{#snippet state()}
		{#if isDraft}<State value="draft" tone="warn" badge />{:else}<State
				value="active"
				tone="muted"
			/>{/if}
	{/snippet}
	{#snippet actions()}
		<Button variant="outline" size="sm" href={`/label?part=${part.id}`}>PRINT LABEL</Button>
		<Button
			variant="outline"
			size="sm"
			href={`/inventory/new?part_id=${part.id}`}
			disabled={isDraft}>RECEIVE STOCK</Button
		>
		<Button variant="outline" size="sm" href={`/parts/${part.id}/edit`}>EDIT</Button>
		{#if detail.deletable}
			<Button variant="destructive" size="sm" onclick={remove}>DELETE</Button>
		{/if}
	{/snippet}
</PageHeader>

{#if isDraft}
	<div
		role="status"
		class="mx-4 mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 border border-warn/50 bg-warn-muted px-3 py-2"
	>
		<State value="draft" tone="warn" badge />
		<dl
			class="grid min-w-0 flex-1 [grid-template-columns:max-content_1fr] gap-x-3 gap-y-0.5 text-xs"
		>
			<dt class="label">Blocks</dt>
			<dd>PO lines · stock receipts · executions · consumption · production output</dd>
			<dt class="label">Activation locks</dt>
			<dd>Internal PN · tier</dd>
			{#if references.length}
				<dt class="label">Referenced by</dt>
				<dd>{references.join(' · ')}</dd>
			{/if}
		</dl>
		<Button size="sm" onclick={activate}>ACTIVATE</Button>
	</div>
{/if}

<div class="grid items-start gap-4 p-4 xl:grid-cols-[minmax(24rem,30rem)_minmax(0,1fr)]">
	<div class="grid min-w-0 gap-3">
		<IdentitySection {detail} fields={data.fields} />
		<DesignSections {detail} />
	</div>
	<div class="grid min-w-0 gap-3">
		<BomSection {detail} />
		<StockSection {detail} />
		<UsageSections {detail} group="purchasing" />
		<SuppliersSection {detail} />
		<UsageSections {detail} group="usage" />
		<BomSection {detail} view="tree" />
	</div>
</div>
<div class="px-4 pb-4">
	<HistorySection partId={part.id} version={part.updated_at} />
</div>
