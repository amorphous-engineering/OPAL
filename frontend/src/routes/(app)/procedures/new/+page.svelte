<script lang="ts">
	// A new template opens as its details: the T-number it would take, name, project, type and
	// description. Nothing is created until CREATE, so leaving costs no number. CREATE goes
	// straight into the editor.
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { PageHeader } from '#lib/components/opal/index.js';
	import DetailsDialog from '#lib/components/procedures/DetailsDialog.svelte';

	let open = $state(true);
	// The list's project filter carries over, so a template starts in the project being looked at.
	const projectId = $derived(Number(page.url.searchParams.get('project')) || 0);
	let leaving = false;

	function leave() {
		if (leaving) return;
		leaving = true;
		void goto('/procedures');
	}
</script>

<PageHeader
	title="New template"
	crumbs={[{ label: 'Templates', href: '/procedures' }, { label: 'New' }]}
/>

<DetailsDialog
	bind:open
	{projectId}
	oncancel={leave}
	oncreated={(p) => {
		leaving = true;
		return goto(`/procedures/${p.id}?edit=1`);
	}}
/>
