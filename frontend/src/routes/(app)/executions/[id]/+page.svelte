<script lang="ts">
	import ExecutionView from '#lib/components/executions/ExecutionView.svelte';
	import type { PageProps } from './$types';

	let { params }: PageProps = $props();
</script>

<!-- Re-created per work order so navigation between executions never reuses live state. -->
{#key params.id}
	<ExecutionView id={Number(params.id)} />
{/key}
