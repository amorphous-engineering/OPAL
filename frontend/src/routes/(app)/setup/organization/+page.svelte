<script lang="ts">
	import { PageHeader } from '#lib/components/opal/index.js';
	import OrganizationForm from '#lib/components/settings/OrganizationForm.svelte';
</script>

<PageHeader
	title="Set up organization"
	crumbs={[{ label: 'System' }, { label: 'Settings', href: '/settings' }, { label: 'Organization' }]}
/>
<div class="mx-auto w-full max-w-5xl p-4">
	<OrganizationForm existing={null} />
</div>
