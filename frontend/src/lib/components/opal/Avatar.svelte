<script lang="ts">
	// A person: their avatar photo (uploaded or from the sign-in provider), else their
	// initials, both in a squircle (.squircle in layout.css). One component wherever
	// a person appears (signatures, notes, presence, comments, menus, lists, profile).
	import { cn } from '#lib/utils.js';

	export interface AvatarUser {
		id?: number | null;
		name?: string | null;
		/** Server-provided URL, cache-busted; absent when the user has no avatar. */
		avatar_url?: string | null;
		// added by org: the new server's camelCase spelling of the same field
		avatarUrl?: string | null;
	}

	let {
		user,
		size = 'sm',
		class: className
	}: {
		user: AvatarUser | null | undefined;
		size?: 'xs' | 'sm' | 'md' | 'lg';
		class?: string;
	} = $props();

	const box = {
		xs: 'size-5 text-xs',
		sm: 'size-6 text-xs',
		md: 'size-9 text-sm',
		lg: 'size-24 text-lg'
	};
	const initials = $derived(
		(user?.name ?? '')
			.split(/\s+/)
			.filter(Boolean)
			.slice(0, 2)
			.map((w) => w[0]?.toUpperCase())
			.join('') || '?'
	);
	const src = $derived(user?.avatarUrl ?? user?.avatar_url ?? null);
	let failed = $state(false);
	$effect(() => {
		void src;
		failed = false;
	});
</script>

{#if src && !failed}
	<img
		{src}
		alt={user?.name ?? ''}
		title={user?.name ?? undefined}
		loading="lazy"
		class={cn('squircle shrink-0 border border-border bg-muted object-cover', box[size], className)}
		onerror={() => (failed = true)}
	/>
{:else}
	<span
		class={cn(
			'squircle inline-flex shrink-0 items-center justify-center border border-border bg-muted font-mono font-medium text-foreground',
			box[size],
			className
		)}
		title={user?.name ?? undefined}
		aria-label={user?.name ?? undefined}>{initials}</span
	>
{/if}
