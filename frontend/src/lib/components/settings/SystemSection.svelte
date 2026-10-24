<script lang="ts">
	import { DetailRow, DetailTable, Section } from '#lib/components/opal/index.js';
	import { bytes, type SystemInfo } from './types.js';

	let { system }: { system: SystemInfo } = $props();
</script>

<Section title="System">
	<DetailTable>
		<DetailRow label="OPAL version"
			><span class="font-mono break-all">{system.opalVersion}</span></DetailRow
		>
		<DetailRow label="Runtime" mono value={system.runtime} />
		<DetailRow label="Platform"
			><span class="font-mono break-all">{system.platform}</span></DetailRow
		>
		<DetailRow label="Server" mono value={system.server} />
		<DetailRow label="Data directory"
			><span class="font-mono break-all">{system.dataDir}</span></DetailRow
		>
		<DetailRow label="Database"><span class="font-mono break-all">{system.dbPath}</span></DetailRow>
		<DetailRow label="Database size" mono value={bytes(system.dbSizeBytes)} />
	</DetailTable>
</Section>
