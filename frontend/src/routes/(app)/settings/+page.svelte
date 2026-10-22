<script lang="ts">
	import { PageHeader } from '#lib/components/opal/index.js';
	import { session } from '#lib/session.svelte.js';
	import AgentSection from '#lib/components/settings/AgentSection.svelte';
	import AuthSummary from '#lib/components/settings/AuthSummary.svelte';
	import ExtensionsSummary from '#lib/components/settings/ExtensionsSummary.svelte';
	import LifecycleSections from '#lib/components/settings/LifecycleSections.svelte';
	import ProjectSummary from '#lib/components/settings/ProjectSummary.svelte';
	import SystemSection from '#lib/components/settings/SystemSection.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const isAdmin = $derived(!!session.user?.is_admin);
</script>

<PageHeader title="Settings" crumbs={[{ label: 'System' }, { label: 'Settings' }]} />

<div class="grid items-start gap-4 p-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
	<div class="grid min-w-0 gap-4">
		<ProjectSummary project={data.project} {isAdmin} />
		<AuthSummary signIn={data.signIn} auth={data.auth} {isAdmin} />
		<AgentSection agent={data.agent} {isAdmin} />
	</div>
	<div class="grid min-w-0 gap-4">
		<ExtensionsSummary items={data.extensions.items} />
		{#if isAdmin}<LifecycleSections lifecycle={data.lifecycle} />{/if}
		<SystemSection system={data.system} />
	</div>
</div>
