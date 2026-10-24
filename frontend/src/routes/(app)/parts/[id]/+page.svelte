<script lang="ts">
	import { goto } from '$app/navigation';
	import { PageHeader, State, confirm, toastError } from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { opal } from '#lib/api.js';
	import { act } from '#lib/components/parts/actions.js';
	import BomSection from '#lib/components/parts/BomSection.svelte';
	import CauseDialog from '#lib/components/parts/CauseDialog.svelte';
	import HistorySection from '#lib/components/parts/HistorySection.svelte';
	import IdentitySection from '#lib/components/parts/IdentitySection.svelte';
	import WhereUsedSection from '#lib/components/parts/WhereUsedSection.svelte';
	import PartRequirementsSection from '#lib/components/requirements/PartRequirementsSection.svelte'; // added by requirements
	import SuppliersSection from '#lib/components/parts/SuppliersSection.svelte'; // added by purchasing
	import PoLinesSection from '#lib/components/parts/PoLinesSection.svelte'; // added by purchasing
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const detail = $derived(data.detail);
	const part = $derived(detail.part);
	const isDraft = $derived(part.state === 'draft');

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
		inventory_records: ['stock record', 'stock records'],
		purchase_lines: ['PO line', 'PO lines']
	};
	const references = $derived(
		Object.entries(detail.references).map(([k, n]) => {
			const [one, many] = REFERENCE_NAMES[k] ?? [k.replace(/_/g, ' '), k.replace(/_/g, ' ')];
			return `${n} ${n === 1 ? one : many}`;
		})
	);

	let activating = $state(false);
	let retiring = $state(false);

	const activate = (cause: string | undefined) =>
		act(() => opal.parts.activate({ id: part.id, cause }), `${part.internalPn} activated`);
	const retire = (cause: string | undefined) =>
		act(() => opal.parts.obsolete({ id: part.id, cause }), `${part.internalPn} obsolete`);

	async function remove() {
		const ok = await confirm({
			title: `Delete ${part.internalPn}`,
			body: `${part.internalPn} is retired permanently and never reissued.`,
			action: 'DELETE',
			destructive: true
		});
		if (!ok) return;
		try {
			await opal.parts.delete({ id: part.id });
			await goto('/parts');
		} catch (e) {
			toastError(e);
		}
	}
</script>

<PageHeader
	title={part.name}
	identifier={part.internalPn}
	crumbs={[{ label: 'Parts', href: '/parts' }, { label: part.internalPn }]}
>
	{#snippet state()}
		{#if isDraft}<State value="draft" tone="warn" badge />
		{:else if part.state === 'obsolete'}<State value="obsolete" tone="error" badge />
		{:else}<State value="active" tone="muted" />{/if}
	{/snippet}
	{#snippet actions()}
		<Button variant="outline" size="sm" href={`/label?part=${part.id}`}>PRINT LABEL</Button>
		<Button
			variant="outline"
			size="sm"
			href={`/inventory/new?part_id=${part.id}`}
			disabled={part.state !== 'active'}>RECEIVE STOCK</Button
		>
		<Button variant="outline" size="sm" href={`/parts/${part.id}/edit`}>EDIT</Button>
		{#if part.state === 'active'}
			<Button variant="outline" size="sm" onclick={() => (retiring = true)}>OBSOLETE</Button>
		{/if}
		{#if detail.deletable}
			<Button variant="destructive" size="sm" onclick={remove}>DELETE</Button>
		{/if}
	{/snippet}
</PageHeader>

{#if isDraft}
	<div
		role="status"
		class="mx-4 mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border border-warn/50 bg-warn-muted px-3 py-2"
	>
		<State value="draft" tone="warn" badge />
		<dl
			class="grid min-w-0 flex-1 [grid-template-columns:max-content_1fr] grid-cols-1 gap-x-3 gap-y-0.5 text-xs"
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
		<Button size="sm" onclick={() => (activating = true)}>ACTIVATE</Button>
	</div>
{/if}

<!-- Sections of other areas (stock, PO lines, suppliers, procedure use, consumption,
	requirements, tests, Onshape) mount here when their area lands. -->
<div
	class="grid grid-cols-1 items-start gap-4 p-4 xl:grid-cols-[minmax(24rem,30rem)_minmax(0,1fr)]"
>
	<div class="grid min-w-0 grid-cols-1 gap-3">
		<IdentitySection {detail} fields={data.fields} />
	</div>
	<div class="grid min-w-0 grid-cols-1 gap-3">
		<BomSection {detail} />
		<SuppliersSection {detail} entries={data.suppliers} />
		<PoLinesSection {detail} lines={data.poLines} />
		<WhereUsedSection {detail} />
		<!-- added by requirements -->
		<PartRequirementsSection
			partId={part.id}
			partNumber={part.internalPn}
			version={part.updatedAt}
		/>
		<BomSection {detail} view="tree" />
	</div>
</div>
<div class="px-4 pb-4">
	<HistorySection partId={part.id} version={part.updatedAt} />
</div>

<CauseDialog
	bind:open={activating}
	title={`Activate ${part.internalPn}`}
	body="Locks the part number and tier permanently."
	action="ACTIVATE"
	placeholder="manual activation from part page"
	onconfirm={activate}
/>
<CauseDialog
	bind:open={retiring}
	title={`Mark ${part.internalPn} obsolete`}
	body="The part leaves service. Records that use it keep it."
	action="OBSOLETE"
	placeholder="marked obsolete from part page"
	destructive
	onconfirm={retire}
/>
