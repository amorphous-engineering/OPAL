<script lang="ts">
	import { PageHeader } from '#lib/components/opal/index.js';
	import { session } from '#lib/session.svelte.js';
	import AgentSection from '#lib/components/settings/AgentSection.svelte';
	import AuthSettings from '#lib/components/settings/AuthSettings.svelte';
	import AuthSummary from '#lib/components/settings/AuthSummary.svelte';
	import ExtensionSettings from '#lib/components/settings/ExtensionSettings.svelte';
	import LifecycleSections from '#lib/components/settings/LifecycleSections.svelte';
	import OnshapeSettings from '#lib/components/settings/OnshapeSettings.svelte';
	import ProjectSettings from '#lib/components/settings/ProjectSettings.svelte';
	import RolesSettings from '#lib/components/settings/RolesSettings.svelte';
	import SettingsGroup from '#lib/components/settings/SettingsGroup.svelte';
	import SystemSection from '#lib/components/settings/SystemSection.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const isAdmin = $derived(!!session.user?.is_admin);
	const onshape = $derived(data.extensions?.items.find((e) => e.id === 'opal.onshape') ?? null);
</script>

<PageHeader title="Settings" crumbs={[{ label: 'System' }, { label: 'Settings' }]} />

<div class="mx-auto grid w-full max-w-5xl grid-cols-1 gap-8 p-4">
	<SettingsGroup id="project" title="Project">
		<ProjectSettings project={data.project} {isAdmin} />
	</SettingsGroup>

	{#if data.auth || data.signIn}
		<SettingsGroup id="sign-in" title="Sign-in">
			{#if data.auth}
				<AuthSettings auth={data.auth} />
			{:else if data.signIn}
				<AuthSummary signIn={data.signIn} />
			{/if}
		</SettingsGroup>
	{/if}

	<SettingsGroup id="roles" title="Roles">
		<RolesSettings roles={data.roles} people={data.people} {isAdmin} />
	</SettingsGroup>

	{#if data.extensions}
		<SettingsGroup id="extensions" title="Extensions">
			<ExtensionSettings extensions={data.extensions} details={data.extensionDetails} {isAdmin} />
		</SettingsGroup>
	{/if}

	{#if onshape}
		<SettingsGroup id="onshape" title="Onshape">
			<OnshapeSettings enabled={onshape.enabled} {isAdmin} settings={data.onshape} />
		</SettingsGroup>
	{/if}

	<SettingsGroup id="agent" title="Agent">
		<AgentSection agent={data.agent} {isAdmin} />
	</SettingsGroup>

	{#if isAdmin && data.lifecycle}
		<SettingsGroup id="lifecycle" title="Lifecycle">
			<LifecycleSections lifecycle={data.lifecycle} />
		</SettingsGroup>
	{/if}

	<SettingsGroup id="system" title="System">
		<SystemSection system={data.system} />
	</SettingsGroup>
</div>
