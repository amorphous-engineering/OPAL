<script lang="ts">
	// Facts about one account. Name and email edit in place.
	import {
		DetailRow,
		DetailTable,
		Section,
		State,
		Timestamp,
		toast,
		toastError
	} from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import type { Workcenter } from '#lib/components/workcenters/types.js';
	import AvatarEditor from './AvatarEditor.svelte';
	import { api } from '#lib/api.js';
	import { session } from '#lib/session.svelte.js';
	import { signInMethods, type UserRecord } from './types.js';

	let {
		profile,
		canEdit,
		isSelf,
		onupdate
	}: {
		profile: UserRecord;
		canEdit: boolean;
		isSelf: boolean;
		onupdate: (u: UserRecord) => void;
	} = $props();

	let editing = $state(false);
	let busy = $state(false);
	let name = $state('');
	let email = $state('');
	let jobTitle = $state('');
	let phone = $state('');
	let workcenterId = $state('');
	let workcenters = $state<Workcenter[]>([]);

	function start() {
		name = profile.name;
		email = profile.email ?? '';
		jobTitle = profile.job_title ?? '';
		phone = profile.phone ?? '';
		workcenterId = profile.workcenter ? String(profile.workcenter.id) : '';
		api
			.get<Workcenter[]>('/workcenters')
			.then((w) => (workcenters = w.filter((x) => x.is_active || String(x.id) === workcenterId)))
			.catch(toastError);
		editing = true;
	}

	async function save(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		try {
			const updated = await api.patch<UserRecord>(`/users/${profile.id}`, {
				name: name.trim(),
				email: email.trim() || null,
				job_title: jobTitle.trim() || null,
				phone: phone.trim() || null,
				workcenter_id: workcenterId ? Number(workcenterId) : null
			});
			onupdate(updated);
			if (isSelf && session.user)
				session.set({
					...session.user,
					name: updated.name,
					avatar_url: updated.avatar_url ?? null
				});
			editing = false;
			toast.success('Profile saved');
		} catch (err) {
			toastError(err);
		} finally {
			busy = false;
		}
	}

	const methods = $derived(signInMethods(profile));
</script>

<Section title="Profile">
	{#snippet actions()}
		{#if canEdit && !editing}
			<Button variant="ghost" size="xs" onclick={start}>EDIT</Button>
		{/if}
	{/snippet}
	<AvatarEditor {profile} {canEdit} {onupdate} />
	<form onsubmit={save}>
		<DetailTable>
			<DetailRow label="Name">
				{#if editing}
					<Input
						bind:value={name}
						aria-label="Name"
						maxlength={255}
						required
						class="h-7 max-w-sm"
					/>
				{:else}{profile.name}{/if}
			</DetailRow>
			<DetailRow label="Username" value={profile.username} mono />
			<DetailRow label="Email">
				{#if editing}
					<Input
						type="email"
						bind:value={email}
						aria-label="Email"
						maxlength={255}
						class="h-7 max-w-sm"
					/>
				{:else if profile.email}
					<a class="text-info hover:underline" href={`mailto:${profile.email}`}>{profile.email}</a>
				{:else}<span class="text-muted-foreground">—</span>{/if}
			</DetailRow>
			<DetailRow label="Job title">
				{#if editing}
					<Input
						bind:value={jobTitle}
						aria-label="Job title"
						maxlength={120}
						class="h-7 max-w-sm"
					/>
				{:else if profile.job_title}{profile.job_title}{:else}<span class="text-muted-foreground"
						>—</span
					>{/if}
			</DetailRow>
			<DetailRow label="Phone">
				{#if editing}
					<Input
						type="tel"
						bind:value={phone}
						aria-label="Phone"
						maxlength={40}
						class="h-7 max-w-sm"
					/>
				{:else if profile.phone}<span class="font-mono text-xs">{profile.phone}</span>{:else}<span
						class="text-muted-foreground">—</span
					>{/if}
			</DetailRow>
			<DetailRow label="Workcenter">
				{#if editing}
					<NativeSelect bind:value={workcenterId} aria-label="Workcenter" class="h-7 max-w-sm">
						<NativeSelectOption value="">—</NativeSelectOption>
						{#each workcenters as w (w.id)}
							<NativeSelectOption value={String(w.id)}>{w.name}</NativeSelectOption>
						{/each}
					</NativeSelect>
				{:else if profile.workcenter}
					<a class="text-info hover:underline" href={`/workcenters/${profile.workcenter.id}`}
						>{profile.workcenter.name}</a
					>
				{:else}<span class="text-muted-foreground">—</span>{/if}
			</DetailRow>
			<DetailRow label="Status">
				{#if profile.is_active}<State value="active" />{:else}<State
						value="inactive"
						tone="muted"
					/>{/if}
			</DetailRow>
			<DetailRow label="Sign-in">
				{#if methods.length}
					<span class="font-mono text-xs">{methods.join(' · ')}</span>
				{:else}
					<State value="unclaimed" tone="warn" />
				{/if}
			</DetailRow>
			<DetailRow label="Last seen">
				{#if profile.is_online}<State value="online" tone="ok" />{:else}<Timestamp
						value={profile.last_seen_at}
					/>{/if}
			</DetailRow>
			<DetailRow label="Activity" value={profile.current_activity} mono />
			<DetailRow label="Created"><Timestamp value={profile.created_at} /></DetailRow>
			<DetailRow label="Updated"><Timestamp value={profile.updated_at} /></DetailRow>
		</DetailTable>
		{#if editing}
			<div class="flex gap-2 border-t border-border px-3 py-2">
				<Button type="submit" size="sm" disabled={busy || !name.trim()}>SAVE</Button>
				<Button variant="outline" size="sm" onclick={() => (editing = false)}>CANCEL</Button>
			</div>
		{/if}
	</form>
</Section>
