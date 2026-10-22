<script lang="ts">
	import { DetailRow, DetailTable, Section, State } from '#lib/components/opal/index.js';
	import { bytes, type SystemInfo } from './types.js';

	let { system }: { system: SystemInfo } = $props();
</script>

<Section title="System">
	<DetailTable>
		<DetailRow label="OPAL version" mono value={system.opal_version} />
		<DetailRow label="Python" mono value={system.python_version} />
		<DetailRow label="Platform" mono value={system.platform} />
		<DetailRow label="Server" mono value={system.server} />
		<DetailRow label="Debug">
			{#if system.debug}<State value="on" tone="warn" label="ON" />{:else}<span
					class="font-mono text-xs">OFF</span
				>{/if}
		</DetailRow>
		<DetailRow label="Data directory"
			><span class="font-mono break-all">{system.data_dir}</span></DetailRow
		>
		<DetailRow label="Database"><span class="font-mono break-all">{system.db_path}</span></DetailRow
		>
		<DetailRow label="Database size" mono value={bytes(system.db_size_bytes)} />
		<DetailRow label="Upload directory"
			><span class="font-mono break-all">{system.upload_dir}</span></DetailRow
		>
		<DetailRow label="Max upload" mono value={bytes(system.max_upload_bytes)} />
	</DetailTable>
</Section>
