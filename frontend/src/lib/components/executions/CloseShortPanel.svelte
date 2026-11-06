<script lang="ts">
	// CLOSE SHORT, inline under the header: a reason and the issue that explains it. A work order
	// with no issue yet raises one in a new tab, and the choice appears here when it is saved.
	import { ErrorBanner, toastError } from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import type { ExecutionStore } from '#lib/execution/store.svelte.js';

	let { store }: { store: ExecutionStore } = $props();

	const issues = $derived((store.doc?.issues ?? []).filter((i) => i.status !== 'void'));
	let reason = $state('');
	let picked = $state('');
	const issueId = $derived(picked || String(issues[0]?.id ?? ''));
	let busy = $state(false);
	let error = $state<string | null>(null);

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		error = null;
		try {
			await store.closeShort(reason.trim(), Number(issueId));
			store.closePanel();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Could not close short';
			toastError(err);
		} finally {
			busy = false;
		}
	}
</script>

<form
	class="grid grid-cols-1 gap-2 border-b border-border bg-muted/30 px-4 py-3"
	aria-label="Close short"
	onsubmit={submit}
>
	<div class="flex flex-wrap items-end gap-3">
		<div class="grid min-w-64 flex-1 grid-cols-1 gap-1">
			<Label for="close-reason">Reason</Label>
			<Input id="close-reason" bind:value={reason} required maxlength={2000} autofocus />
		</div>
		<div class="grid min-w-56 grid-cols-1 gap-1">
			<Label for="close-issue">Issue</Label>
			{#if issues.length}
				<NativeSelect
					id="close-issue"
					class="w-full"
					value={issueId}
					onchange={(e) => (picked = e.currentTarget.value)}
				>
					{#each issues as i (i.id)}
						<NativeSelectOption value={String(i.id)}>{i.issue_number} {i.title}</NativeSelectOption>
					{/each}
				</NativeSelect>
			{:else}
				<Button variant="outline" size="sm" href={store.issueUrl()} target="_blank" rel="noopener">
					+ ISSUE
				</Button>
			{/if}
		</div>
		<Button
			type="submit"
			size="sm"
			class="bg-error-fill text-error-on shadow-key hover:bg-error-fill"
			disabled={busy || !reason.trim() || !issueId}>CLOSE SHORT</Button
		>
		<Button size="sm" variant="ghost" onclick={() => store.closePanel()}>CANCEL</Button>
	</div>
	<p class="text-xs text-error">The work order stops here and does not reopen.</p>
	<ErrorBanner message={error} />
</form>
