<script lang="ts">
	import { goto } from '$app/navigation';
	import { PageHeader } from '#lib/components/opal/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import SyncLogTable from '#lib/components/settings/SyncLogTable.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	function setDirection(direction: string) {
		goto(direction ? `?direction=${direction}` : '?', { replace: true, reset: false });
	}
</script>

<PageHeader
	title="Onshape sync log"
	crumbs={[
		{ label: 'System' },
		{ label: 'Settings', href: '/settings' },
		{ label: 'Extensions', href: '/settings/extensions' },
		{ label: 'opal.onshape', href: '/settings/extensions/opal.onshape' },
		{ label: 'Sync log' }
	]}
>
	{#snippet meta()}<span class="mono">{data.logs.length}</span> most recent{/snippet}
</PageHeader>

<div class="flex items-center gap-2 border-b border-border px-4 py-2">
	<NativeSelect.Root
		size="sm"
		aria-label="Direction"
		value={data.direction}
		onchange={(e) => setDirection(e.currentTarget.value)}
	>
		<NativeSelect.Option value="">All directions</NativeSelect.Option>
		<NativeSelect.Option value="pull">Pull</NativeSelect.Option>
		<NativeSelect.Option value="push">Push</NativeSelect.Option>
	</NativeSelect.Root>
</div>

<SyncLogTable logs={data.logs} />
