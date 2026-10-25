<script lang="ts">
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import { goto } from '$app/navigation';
	import { setMode, userPrefersMode } from 'mode-watcher';
	import CaretDownIcon from 'phosphor-svelte/lib/CaretDown';
	import ClockIcon from 'phosphor-svelte/lib/Clock';
	import GearIcon from 'phosphor-svelte/lib/Gear';
	import GlobeIcon from 'phosphor-svelte/lib/Globe';
	import MonitorIcon from 'phosphor-svelte/lib/Monitor';
	import MoonIcon from 'phosphor-svelte/lib/Moon';
	import PaletteIcon from 'phosphor-svelte/lib/Palette';
	import ScrollIcon from 'phosphor-svelte/lib/Scroll';
	import SignOutIcon from 'phosphor-svelte/lib/SignOut';
	import SunIcon from 'phosphor-svelte/lib/Sun';
	import UserCircleIcon from 'phosphor-svelte/lib/UserCircle';
	import UsersIcon from 'phosphor-svelte/lib/Users';
	import { Avatar, toastError } from '#lib/components/opal/index.js';
	import { session } from '#lib/session.svelte.js';
	import { NAV_SHORTCUTS } from '#lib/shortcuts.js';

	const user = $derived(session.user);
	const shortcut = (href: string) => NAV_SHORTCUTS.find((s) => s.href === href)?.keys;

	const THEMES = [
		{ value: 'light', label: 'Light', icon: SunIcon },
		{ value: 'dark', label: 'Dark', icon: MoonIcon },
		{ value: 'system', label: 'System', icon: MonitorIcon }
	] as const;
	const theme = $derived(THEMES.find((t) => t.value === userPrefersMode.current) ?? THEMES[2]);

	// The local zone name (PDT, CET) makes "Local" concrete, whichever mode is chosen.
	const localZone =
		new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' })
			.formatToParts(new Date())
			.find((p) => p.type === 'timeZoneName')?.value ?? 'local';
	const time = $derived(user?.time_display === 'utc' ? 'UTC' : `Local · ${localZone}`);

	function setTime(value: string) {
		if (value !== 'local' && value !== 'utc') return;
		session.setTimeDisplay(value).catch((e) => toastError(e, 'Time display not saved'));
	}

	async function signOut() {
		await session.logout().catch(() => {});
		goto('/login');
	}
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger
		aria-label="Account menu"
		class="group inline-flex h-7 items-center gap-1.5 rounded-md border border-border pr-1.5 pl-0.5 text-xs hover:bg-accent data-[state=open]:bg-accent"
	>
		<Avatar {user} size="sm" />
		<span class="hidden max-w-40 truncate font-medium sm:inline">{user?.name ?? '—'}</span>
		<CaretDownIcon
			aria-hidden="true"
			class="size-3 text-muted-foreground transition-transform group-data-[state=open]:rotate-180"
		/>
	</DropdownMenu.Trigger>

	<DropdownMenu.Content align="end" sideOffset={6} class="w-72 p-0">
		<!-- Who is signed in. Not an item: nothing to select. -->
		<div class="flex items-start gap-3 border-b border-border p-3">
			<Avatar {user} size="md" />
			<div class="min-w-0 flex-1">
				<div class="flex items-center gap-2">
					<span class="truncate text-sm font-medium">{user?.name}</span>
					{#if user?.is_admin}
						<span
							class="rounded-sm border border-info/40 px-1 font-mono text-[0.625rem] tracking-wider text-info"
							>ADMIN</span
						>
					{/if}
				</div>
				<div class="truncate font-mono text-xs text-muted-foreground">@{user?.username}</div>
				{#if user?.job_title}<div class="truncate text-xs text-muted-foreground">
						{user.job_title}
					</div>{/if}
				{#if user?.email}<div class="truncate text-xs text-muted-foreground">{user.email}</div>{/if}
			</div>
		</div>

		<div class="p-1">
			<DropdownMenu.Group>
				<DropdownMenu.Item onSelect={() => goto(`/users/${user?.id}`)}>
					<UserCircleIcon />Profile
				</DropdownMenu.Item>
			</DropdownMenu.Group>

			<DropdownMenu.Separator />
			<DropdownMenu.Group>
				<DropdownMenu.GroupHeading>Organization</DropdownMenu.GroupHeading>
				<DropdownMenu.Item onSelect={() => goto('/settings')}>
					<GearIcon />Settings
				</DropdownMenu.Item>
				{#if user?.is_admin}
					<DropdownMenu.Item onSelect={() => goto('/users')}>
						<UsersIcon />Users
					</DropdownMenu.Item>
				{/if}
				<DropdownMenu.Item onSelect={() => goto('/audit')}>
					<ScrollIcon />Audit log
					{#if shortcut('/audit')}<DropdownMenu.Shortcut>{shortcut('/audit')}</DropdownMenu.Shortcut
						>{/if}
				</DropdownMenu.Item>
			</DropdownMenu.Group>

			<DropdownMenu.Separator />
			<DropdownMenu.Group>
				<DropdownMenu.GroupHeading>Preferences</DropdownMenu.GroupHeading>
				<DropdownMenu.Sub>
					<DropdownMenu.SubTrigger>
						<PaletteIcon />Theme
						<span class="flex-1 text-right text-muted-foreground">{theme.label}</span>
					</DropdownMenu.SubTrigger>
					<DropdownMenu.SubContent class="w-40">
						<DropdownMenu.RadioGroup
							value={userPrefersMode.current}
							onValueChange={(v) => setMode(v as 'light' | 'dark' | 'system')}
						>
							{#each THEMES as t (t.value)}
								<DropdownMenu.RadioItem value={t.value}><t.icon />{t.label}</DropdownMenu.RadioItem>
							{/each}
						</DropdownMenu.RadioGroup>
					</DropdownMenu.SubContent>
				</DropdownMenu.Sub>
				<DropdownMenu.Sub>
					<DropdownMenu.SubTrigger>
						<ClockIcon />Time
						<span class="flex-1 text-right text-muted-foreground">{time}</span>
					</DropdownMenu.SubTrigger>
					<DropdownMenu.SubContent class="w-44">
						<DropdownMenu.RadioGroup value={user?.time_display ?? 'local'} onValueChange={setTime}>
							<DropdownMenu.RadioItem value="local"
								><ClockIcon />Local
								<span class="text-muted-foreground">{localZone}</span></DropdownMenu.RadioItem
							>
							<DropdownMenu.RadioItem value="utc"><GlobeIcon />UTC</DropdownMenu.RadioItem>
						</DropdownMenu.RadioGroup>
					</DropdownMenu.SubContent>
				</DropdownMenu.Sub>
			</DropdownMenu.Group>

			<DropdownMenu.Separator />
			<DropdownMenu.Item variant="destructive" onSelect={signOut}>
				<SignOutIcon />Sign out
			</DropdownMenu.Item>
		</div>
	</DropdownMenu.Content>
</DropdownMenu.Root>
