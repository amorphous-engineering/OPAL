<script lang="ts">
	// The waiver asks for its reason in place, like SKIP: the reason is the record, and typing it is
	// the confirmation. Once written it stands: a correction is a note on the step.
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';

	let {
		label,
		onwaive,
		oncancel
	}: { label: string; onwaive: (reason: string) => Promise<boolean>; oncancel: () => void } =
		$props();

	let reason = $state('');
	let busy = $state(false);

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		if (busy || !reason.trim()) return;
		busy = true;
		try {
			if (await onwaive(reason.trim())) reason = '';
		} finally {
			busy = false;
		}
	}
</script>

<form class="flex max-w-xl flex-wrap items-center gap-2" onsubmit={submit} data-waiver-form>
	<Input
		class="h-7 min-w-48 flex-1 font-sans"
		aria-label={`Reason to waive ${label}`}
		placeholder="Reason"
		required
		maxlength={2000}
		autofocus
		bind:value={reason}
	/>
	<Button type="submit" size="sm" disabled={busy || !reason.trim()}
		>WAIVE {label.toUpperCase()}</Button
	>
	<Button variant="ghost" size="sm" onclick={oncancel}>CANCEL</Button>
</form>
