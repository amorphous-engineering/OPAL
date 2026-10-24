<script lang="ts">
	// The large avatar on the profile with UPLOAD / REMOVE. The photo is centre-cropped
	// to a square and resized to 256 px in the browser before it is sent.
	import { Avatar, confirm, toast, toastError } from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { opal } from '#lib/api.js';
	import { squareAvatar, toBase64 } from './avatar.js';
	import type { UserRecord } from './types.js';

	let {
		profile,
		canEdit,
		onupdate
	}: { profile: UserRecord; canEdit: boolean; onupdate: (u: UserRecord) => void } = $props();

	let busy = $state(false);
	let input = $state<HTMLInputElement>();

	async function picked() {
		const file = input?.files?.[0];
		if (input) input.value = '';
		if (!file) return;
		busy = true;
		try {
			const blob = await squareAvatar(file);
			onupdate(await opal.org.users.uploadAvatar({ id: profile.id, data: await toBase64(blob) }));
			toast.success('Avatar saved');
		} catch (err) {
			toastError(err);
		} finally {
			busy = false;
		}
	}

	async function remove() {
		const ok = await confirm({
			title: 'Remove the avatar?',
			body: 'The initials show instead. Single sign-on does not restore it.',
			action: 'REMOVE AVATAR',
			destructive: true
		});
		if (!ok) return;
		busy = true;
		try {
			onupdate(await opal.org.users.removeAvatar({ id: profile.id }));
			toast.success('Avatar removed');
		} catch (err) {
			toastError(err);
		} finally {
			busy = false;
		}
	}
</script>

<div class="flex items-center gap-4 border-b border-border px-3 py-3">
	<Avatar user={profile} size="lg" />
	{#if canEdit}
		<div class="flex flex-wrap gap-2">
			<input
				bind:this={input}
				type="file"
				accept="image/png,image/jpeg,image/webp,image/gif"
				class="sr-only"
				tabindex="-1"
				aria-label="Avatar file"
				onchange={picked}
			/>
			<Button variant="outline" size="sm" disabled={busy} onclick={() => input?.click()}
				>{profile.avatarUrl ? 'REPLACE AVATAR' : 'UPLOAD AVATAR'}</Button
			>
			{#if profile.avatarUrl}
				<Button variant="outline" size="sm" disabled={busy} onclick={remove}>REMOVE AVATAR</Button>
			{/if}
		</div>
	{/if}
</div>
