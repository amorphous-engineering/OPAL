<script lang="ts">
	import { PageHeader, State } from '#lib/components/opal/index.js';
	import PartForm from '#lib/components/parts/PartForm.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<PageHeader
	title={data.part.name}
	identifier={data.part.internal_pn}
	crumbs={[
		{ label: 'Parts', href: '/parts' },
		{ label: data.part.internal_pn ?? data.part.name, href: `/parts/${data.part.id}` },
		{ label: 'Edit' }
	]}
>
	{#snippet state()}
		{#if data.part.lifecycle_state === 'draft'}<State value="draft" tone="warn" badge />{/if}
	{/snippet}
</PageHeader>
{#key data.part.id}
	<PartForm schema={data.schema} part={data.part} parent={data.parent} />
{/key}
