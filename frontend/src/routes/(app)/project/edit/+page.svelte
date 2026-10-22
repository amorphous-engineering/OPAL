<script lang="ts">
	import { PageHeader } from '#lib/components/opal/index.js';
	import ProjectForm from '#lib/components/settings/ProjectForm.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<PageHeader
	title="Edit project"
	crumbs={[{ label: 'System' }, { label: 'Settings', href: '/settings' }, { label: 'Project' }]}
/>
<ProjectForm existing={data.project} />
