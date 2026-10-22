<script lang="ts">
	import { Section, toast, toastError } from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { api } from '#lib/api.js';

	let { hasPassword, onchanged }: { hasPassword: boolean; onchanged: () => void } = $props();

	let current = $state('');
	let next = $state('');
	let confirmNext = $state('');
	let busy = $state(false);
	let error = $state<string | null>(null);

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		error = null;
		if (next !== confirmNext) {
			error = 'The two new passwords differ';
			return;
		}
		busy = true;
		try {
			const r = await api.post<{ other_sessions_revoked: number }>('/auth/password', {
				current_password: current,
				new_password: next
			});
			current = next = confirmNext = '';
			toast.success(
				r.other_sessions_revoked
					? `Password changed. ${r.other_sessions_revoked} other session(s) signed out.`
					: 'Password changed'
			);
			onchanged();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Could not change the password';
			toastError(err);
		} finally {
			busy = false;
		}
	}
</script>

<Section title="Password">
	<form class="grid max-w-sm gap-3 p-3" onsubmit={submit}>
		{#if error}
			<p role="alert" class="border border-error/40 bg-error-muted px-2 py-1.5 text-xs text-error">
				{error}
			</p>
		{/if}
		{#if hasPassword}
			<div class="grid gap-1.5">
				<Label for="pw-current">Current password</Label>
				<Input
					id="pw-current"
					type="password"
					bind:value={current}
					autocomplete="current-password"
					required
				/>
			</div>
		{/if}
		<div class="grid gap-1.5">
			<Label for="pw-new">New password</Label>
			<Input
				id="pw-new"
				type="password"
				bind:value={next}
				minlength={10}
				autocomplete="new-password"
				required
			/>
			<span class="text-[11px] text-muted-foreground">At least 10 characters.</span>
		</div>
		<div class="grid gap-1.5">
			<Label for="pw-confirm">Confirm new password</Label>
			<Input
				id="pw-confirm"
				type="password"
				bind:value={confirmNext}
				minlength={10}
				autocomplete="new-password"
				required
			/>
		</div>
		<div>
			<Button type="submit" size="sm" disabled={busy}>CHANGE PASSWORD</Button>
		</div>
	</form>
</Section>
