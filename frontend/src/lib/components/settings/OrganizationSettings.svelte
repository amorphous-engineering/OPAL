<script lang="ts">
	// Admins edit the organization settings in place; everyone else reads them. Missing settings
	// send the admin to first-time setup.
	import { EmptyLine } from '#lib/components/opal/index.js';
	import OrganizationForm from './OrganizationForm.svelte';
	import OrganizationSummary from './OrganizationSummary.svelte';
	import type { OrgSettings } from './types.js';

	let { organization, isAdmin }: { organization: OrgSettings | null; isAdmin: boolean } = $props();
</script>

{#if organization && isAdmin}
	<OrganizationForm existing={organization} />
{:else if organization}
	<OrganizationSummary {organization} />
{:else if isAdmin}
	<EmptyLine label="Organization" addHref="/setup/organization" addLabel="+ CONFIGURE" />
{:else}
	<EmptyLine label="Organization" />
{/if}
