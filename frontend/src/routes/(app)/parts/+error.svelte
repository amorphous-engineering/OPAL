<script lang="ts">
	import { page } from '$app/state';
	import { PageHeader } from '#lib/components/opal/index.js';
</script>

<PageHeader
	title={page.status === 404 ? 'Part not found' : 'Parts'}
	crumbs={[{ label: 'Parts', href: '/parts' }]}
/>
<p
	role="alert"
	class="m-4 border border-error/40 bg-error-muted px-3 py-2 font-mono text-xs text-error"
>
	{page.error?.message ?? 'Request failed'}
</p>
