<script lang="ts">
	// Pages open for reading. EDIT reveals what is still pencil and DONE returns. The mode lives in
	// the URL (`?edit=1`), so a reload or a shared link keeps it. Read it with `isEditing(page.url)`.
	import { page } from '$app/state';
	import { Button } from '#lib/components/ui/button/index.js';
	import { isEditing, queryHref } from './listquery.js';

	let { label = 'EDIT' }: { label?: string } = $props();

	const editing = $derived(isEditing(page.url));
</script>

<Button
	size="sm"
	variant={editing ? 'default' : 'outline'}
	href={queryHref({ edit: editing ? null : '1' })}
	data-sveltekit-noscroll
	data-sveltekit-keepfocus>{editing ? 'DONE' : label}</Button
>
