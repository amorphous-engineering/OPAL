<script lang="ts">
	// A value to copy: shown in full (selectable) with a COPY action beside it.
	import { Button } from '#lib/components/ui/button/index.js';
	import { toast } from '#lib/components/opal/index.js';

	let { value, label }: { value: string; label: string } = $props();
	let copied = $state(false);

	async function copy() {
		try {
			await navigator.clipboard.writeText(value);
			copied = true;
			setTimeout(() => (copied = false), 2000);
		} catch {
			toast.error('Copy failed. Select the text and copy it by hand.');
		}
	}
</script>

<div class="flex items-start gap-2">
	<code
		aria-label={label}
		class="min-w-0 flex-1 border border-border bg-muted px-2 py-1 font-mono text-xs break-all select-all"
		>{value}</code
	>
	<Button variant="outline" size="sm" onclick={copy}>{copied ? 'COPIED' : 'COPY'}</Button>
</div>
