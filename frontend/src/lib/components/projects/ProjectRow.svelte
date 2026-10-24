<script lang="ts">
	// The "Project" detail row of a scoped record: code links to the project page.
	import { DetailRow } from '#lib/components/opal/index.js';

	let { id, code, name }: { id: number; code: string; name: string } = $props();
</script>

<DetailRow label="Project">
	<a href={`/projects/${id}`} class="font-mono text-info hover:underline">{code}</a>
	<span class="text-muted-foreground">{name}</span>
</DetailRow>
