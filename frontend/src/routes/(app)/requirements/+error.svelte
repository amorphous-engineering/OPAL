<script lang="ts">
	import { page } from '$app/state';
	import { PageHeader } from '#lib/components/opal/index.js';
</script>

<PageHeader
	title={page.status === 404 ? 'Not found' : 'Error'}
	crumbs={[{ label: 'Requirements', href: '/requirements' }]}
/>
<p
	role="alert"
	class="m-4 max-w-xl border border-error/40 bg-error-muted px-2 py-1.5 text-xs text-error"
>
	{page.error?.message ?? 'Request failed'}
</p>
