<script lang="ts">
	import { PageHeader, State } from '#lib/components/opal/index.js';
	import PartForm from '#lib/components/parts/PartForm.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<PageHeader
	title={data.part.name}
	identifier={data.part.internalPn}
	crumbs={[
		{ label: 'Parts', href: '/parts' },
		{ label: data.part.internalPn, href: `/parts/${data.part.id}` },
		{ label: 'Edit' }
	]}
>
	{#snippet state()}
		{#if data.part.state === 'draft'}<State value="draft" tone="warn" badge />{/if}
	{/snippet}
</PageHeader>
{#key data.part.id}
	<PartForm schema={data.schema} part={data.part} />
{/key}
