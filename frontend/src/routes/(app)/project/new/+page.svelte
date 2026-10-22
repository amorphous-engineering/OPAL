<script lang="ts">
	import { PageHeader } from '#lib/components/opal/index.js';
	import ProjectForm from '#lib/components/settings/ProjectForm.svelte';
</script>

<PageHeader
	title="New project"
	crumbs={[{ label: 'System' }, { label: 'Settings', href: '/settings' }, { label: 'Project' }]}
/>
<ProjectForm existing={null} />
