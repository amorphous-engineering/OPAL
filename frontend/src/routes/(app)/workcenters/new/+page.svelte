<script lang="ts">
	import { goto } from '$app/navigation';
	import { opal } from '#lib/api.js';
	import { PageHeader, toastError } from '#lib/components/opal/index.js';
	import WorkcenterForm from '#lib/components/workcenters/WorkcenterForm.svelte';
	import type { WorkcenterInput } from '#lib/components/workcenters/types.js';

	let busy = $state(false);
	let error = $state<string | null>(null);

	async function create(v: WorkcenterInput) {
		busy = true;
		error = null;
		try {
			const wc = await opal.org.workcenters.create(v);
			await goto(`/workcenters/${wc.id}`);
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to create workcenter';
			toastError(e);
		} finally {
			busy = false;
		}
	}
</script>

<PageHeader
	title="New workcenter"
	crumbs={[{ label: 'Workcenters', href: '/workcenters' }, { label: 'New' }]}
/>

<div class="max-w-xl p-4">
	<WorkcenterForm
		title="Workcenter"
		submitLabel="CREATE"
		cancel="/workcenters"
		{busy}
		{error}
		onsubmit={create}
	/>
</div>
