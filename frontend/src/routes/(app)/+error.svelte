<script lang="ts">
	// Shared failure page for every (app) route: a load threw or called error().
	// One line of fact, the way out. The shell around it stays usable.
	import { page } from '$app/state';
	import { PageHeader } from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';

	const status = $derived(page.status);
	const title = $derived(
		status === 404
			? 'Not found'
			: status === 403
				? 'Not permitted'
				: status >= 500
					? 'Server error'
					: 'Could not load'
	);
</script>

<PageHeader {title} identifier={String(status)} />

<div class="p-4">
	<div class="max-w-2xl overflow-hidden rounded-lg border border-border bg-card">
		<p role="alert" class="px-3 py-2 text-sm">{page.error?.message ?? 'Something went wrong'}</p>
		<div class="flex items-center gap-2 border-t border-border p-2">
			<Button size="sm" variant="outline" onclick={() => history.back()}>BACK</Button>
			{#if status >= 500 || status === 0}
				<Button size="sm" variant="outline" onclick={() => location.reload()}>RETRY</Button>
			{/if}
			<Button size="sm" variant="ghost" href="/">OVERVIEW</Button>
		</div>
	</div>
</div>
