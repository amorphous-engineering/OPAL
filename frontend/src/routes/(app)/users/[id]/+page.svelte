<script lang="ts">
	import { goto, refreshAll } from '$app/navigation';
	import { page } from '$app/state';
	import {
		Avatar,
		confirm,
		PageHeader,
		Section,
		State,
		toast,
		toastError
	} from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { api } from '#lib/api.js';
	import { session } from '#lib/session.svelte.js';
	import ActivitySection from '#lib/components/users/ActivitySection.svelte';
	import ClaimSection from '#lib/components/users/ClaimSection.svelte';
	import PasskeysSection from '#lib/components/users/PasskeysSection.svelte';
	import PasswordSection from '#lib/components/users/PasswordSection.svelte';
	import PreferencesSection from '#lib/components/users/PreferencesSection.svelte';
	import ProfileSection from '#lib/components/users/ProfileSection.svelte';
	import SessionsSection from '#lib/components/users/SessionsSection.svelte';
	import TokensSection from '#lib/components/users/TokensSection.svelte';
	import RolesSection from '#lib/components/users/RolesSection.svelte';
	import type { RoleRef } from '#lib/components/users/roles.js';
	import type { UserRecord } from '#lib/components/users/types.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	// Follows the loaded data; edits assign over it until the next reload.
	let profile = $derived<UserRecord>(data.profile);

	const isAdmin = $derived(!!session.user?.is_admin);
	const isSelf = $derived(data.isSelf);
	const canEdit = $derived(isAdmin || isSelf);
	/** Bumped when something changes the account's sessions. */
	let sessionsVersion = $state(0);
	let passkeysEnabled = $state(true);
	/** Reset or a fresh account leaves it passwordless: show the claim section. */
	const needsClaim = $derived(profile.is_active && !profile.has_password && !isSelf);
	const autoIssue = $derived(page.url.searchParams.get('claim') === '1');

	$effect(() => {
		if (!isSelf) return;
		api
			.get<{ passkeys_enabled: boolean }>('/auth/config')
			.then((c) => (passkeysEnabled = c.passkeys_enabled))
			.catch(() => {});
	});

	async function patch(body: Record<string, unknown>, done: string) {
		try {
			profile = await api.patch<UserRecord>(`/users/${profile.id}`, body);
			toast.success(done);
			await refreshAll();
		} catch (err) {
			toastError(err);
		}
	}

	async function toggleAdmin() {
		const grant = !profile.is_admin;
		const ok = await confirm({
			title: grant
				? `Make ${profile.name} an administrator?`
				: `Remove ${profile.name} as administrator?`,
			body: grant
				? 'Administrators manage users, project configuration and instance settings.'
				: 'They lose access to user management, project configuration and instance settings.',
			action: grant ? 'MAKE ADMIN' : 'REMOVE ADMIN',
			destructive: !grant
		});
		if (ok)
			await patch({ is_admin: grant }, grant ? 'Administrator added' : 'Administrator removed');
	}

	async function toggleActive() {
		if (profile.is_active) {
			const ok = await confirm({
				title: `Deactivate ${profile.name}?`,
				body: 'They are signed out everywhere and cannot sign in. Their history stays.',
				action: 'DEACTIVATE',
				destructive: true
			});
			if (ok) await patch({ is_active: false }, 'Account deactivated');
		} else {
			await patch({ is_active: true }, 'Account reactivated');
		}
	}

	async function resetPassword() {
		const ok = await confirm({
			title: `Reset the password for ${profile.name}?`,
			body: 'Their password is cleared and every session ends. They set a new one through a claim link you hand over.',
			action: 'RESET PASSWORD',
			destructive: true
		});
		if (!ok) return;
		try {
			await api.post(`/users/${profile.id}/reset-password`);
			await goto(`/users/${profile.id}?claim=1`, { replace: true, refreshAll: true });
			toast.success('Password cleared');
		} catch (err) {
			toastError(err);
		}
	}

	async function deactivateSelf() {
		const ok = await confirm({
			title: 'Deactivate your account?',
			body: 'You are signed out everywhere and cannot sign back in until an administrator reactivates the account. Your history stays.',
			action: 'DEACTIVATE MY ACCOUNT',
			destructive: true,
			typeToConfirm: profile.username
		});
		if (!ok) return;
		try {
			await api.del(`/users/${profile.id}`);
			session.set(null);
			await goto('/login');
		} catch (err) {
			toastError(err);
		}
	}
</script>

<PageHeader
	title={profile.name}
	identifier={profile.username}
	crumbs={isAdmin
		? [{ label: 'System' }, { label: 'Users', href: '/users' }, { label: profile.name }]
		: [{ label: 'Profile' }]}
>
	{#snippet heading()}
		<span class="flex items-center gap-2">
			<Avatar user={profile} size="md" />
			<h1 class="text-lg font-semibold tracking-tight">{profile.name}</h1>
		</span>
	{/snippet}
	{#snippet state()}
		{#if !profile.is_active}<State value="inactive" tone="muted" badge />{/if}
	{/snippet}
	{#snippet actions()}
		{#if isAdmin}
			<Button variant="outline" size="sm" onclick={toggleAdmin}
				>{profile.is_admin ? 'REMOVE ADMIN' : 'MAKE ADMIN'}</Button
			>
			{#if !isSelf}
				{#if profile.is_active && profile.has_password}
					<Button variant="outline" size="sm" onclick={resetPassword}>RESET PASSWORD</Button>
				{/if}
				<Button variant="outline" size="sm" onclick={toggleActive}
					>{profile.is_active ? 'DEACTIVATE' : 'REACTIVATE'}</Button
				>
			{/if}
		{/if}
	{/snippet}
</PageHeader>

<div class="grid grid-cols-1 items-start gap-4 p-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
	<div class="grid min-w-0 grid-cols-1 gap-4">
		<ProfileSection
			{profile}
			{canEdit}
			{isSelf}
			onupdate={(u) => {
				profile = u;
				if (isSelf && session.user)
					session.set({ ...session.user, name: u.name, avatar_url: u.avatar_url ?? null });
				refreshAll();
			}}
		/>
		<RolesSection userId={profile.id} roles={(profile as { roles?: RoleRef[] }).roles} {isAdmin} />
		{#if needsClaim}
			{#key profile.id}
				<ClaimSection userId={profile.id} {autoIssue} />
			{/key}
		{/if}
		{#if isSelf}
			<PasswordSection hasPassword={profile.has_password} onchanged={() => sessionsVersion++} />
			<PreferencesSection />
		{/if}
	</div>
	<div class="grid min-w-0 grid-cols-1 gap-4">
		{#if isSelf}
			<PasskeysSection enabled={passkeysEnabled} onchanged={() => refreshAll()} />
			<SessionsSection version={sessionsVersion} />
			<TokensSection />
		{/if}
		<ActivitySection entries={data.activity} userId={profile.id} />
		{#if isSelf}
			<Section title="Account">
				<div class="p-3">
					<Button variant="destructive" size="sm" onclick={deactivateSelf}
						>DEACTIVATE MY ACCOUNT</Button
					>
				</div>
			</Section>
		{/if}
	</div>
</div>
