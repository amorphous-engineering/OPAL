<script lang="ts">
	import { ActionLink, DetailRow, DetailTable, Section } from '#lib/components/opal/index.js';
	import { bytes, type SystemInfo } from './types.js';

	let { system }: { system: SystemInfo } = $props();

	const reportUrl = $derived(
		`https://github.com/amorphous-engineering/OPAL/issues/new?template=bug.yml&version=${encodeURIComponent(system.opalVersion)}`
	);
</script>

<Section title="System">
	<DetailTable>
		<DetailRow label="OPAL version"
			><span class="font-mono break-all">{system.opalVersion}</span></DetailRow
		>
		<DetailRow label="Feedback"
			><ActionLink href={reportUrl} target="_blank" rel="noopener">REPORT A PROBLEM</ActionLink
			></DetailRow
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
