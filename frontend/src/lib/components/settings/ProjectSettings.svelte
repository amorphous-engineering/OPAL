<script lang="ts">
	// Admins edit the project config in place; everyone else reads it. A missing project
	// sends the admin to first-time setup.
	import { EmptyLine } from '#lib/components/opal/index.js';
	import ProjectForm from './ProjectForm.svelte';
	import ProjectSummary from './ProjectSummary.svelte';
	import type { ProjectConfig } from './types.js';

	let { project, isAdmin }: { project: ProjectConfig | null; isAdmin: boolean } = $props();
</script>

{#if project && isAdmin}
	<ProjectForm existing={project} />
{:else if project}
	<ProjectSummary {project} />
{:else if isAdmin}
	<EmptyLine label="Project" addHref="/project/new" addLabel="+ CONFIGURE" />
{:else}
	<EmptyLine label="Project" />
{/if}
