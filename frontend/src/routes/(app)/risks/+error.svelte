<script lang="ts">
	import { page } from '$app/state';
	import { PageHeader } from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
</script>

<PageHeader title={page.status === 404 ? 'Risk not found' : 'Risk unavailable'}>
	{#snippet actions()}
		<Button variant="outline" href="/risks">REGISTER</Button>
	{/snippet}
</PageHeader>
<p class="p-4 font-mono text-xs text-muted-foreground">{page.error?.message}</p>
