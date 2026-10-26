<script lang="ts">
	import { PageHeader } from '#lib/components/opal/index.js';
	import PartForm from '#lib/components/parts/PartForm.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<PageHeader
	title="New variant"
	identifier={data.nextNumber}
	crumbs={[
		{ label: 'Parts', href: '/parts' },
		{ label: data.part.internalPn, href: `/parts/${data.part.id}` },
		{ label: 'Variant' }
	]}
/>
{#key data.part.id}
	<PartForm schema={data.schema} variantOf={data.part} nextNumber={data.nextNumber} />
{/key}
