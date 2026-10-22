<script lang="ts">
	import { PageHeader } from '#lib/components/opal/index.js';
	import PartForm from '#lib/components/parts/PartForm.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<PageHeader title="New part" crumbs={[{ label: 'Parts', href: '/parts' }, { label: 'New' }]} />
<PartForm schema={data.schema} parent={data.parent} tier={data.tier} />
