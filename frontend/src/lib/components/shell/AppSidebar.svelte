<script lang="ts">
	import * as Sidebar from '#lib/components/ui/sidebar/index.js';
	import { page } from '$app/state';
	import { NAV, isActive } from '#lib/nav.js';
	import { session } from '#lib/session.svelte.js';
</script>

<Sidebar.Root collapsible="offcanvas">
	<Sidebar.Header class="h-11 justify-center border-b border-sidebar-border px-3">
		<a href="/" class="font-mono text-sm font-bold tracking-[0.2em]" aria-label="OPAL, overview"
			>OPAL</a
		>
	</Sidebar.Header>
	<Sidebar.Content class="gap-0">
		<nav aria-label="Primary" class="contents">
			<Sidebar.Group class="py-1">
				<Sidebar.Menu>
					<Sidebar.MenuItem>
						<Sidebar.MenuButton isActive={page.url.pathname === '/'}>
							{#snippet child({ props })}<a
									href="/"
									{...props}
									aria-current={page.url.pathname === '/' ? 'page' : undefined}
									><span>Overview</span></a
								>{/snippet}
						</Sidebar.MenuButton>
					</Sidebar.MenuItem>
				</Sidebar.Menu>
			</Sidebar.Group>
			{#each NAV as group (group.label)}
				<Sidebar.Group class="py-1">
					<Sidebar.GroupLabel class="label h-6">{group.label}</Sidebar.GroupLabel>
					<Sidebar.Menu>
						{#each group.items.filter((i) => !i.adminOnly || session.user?.is_admin) as item (item.href)}
							<Sidebar.MenuItem>
								<Sidebar.MenuButton isActive={isActive(page.url.pathname, item.href)}>
									{#snippet child({ props })}
										<a
											href={item.href}
											{...props}
											aria-current={isActive(page.url.pathname, item.href) ? 'page' : undefined}
											><span>{item.label}</span></a
										>
									{/snippet}
								</Sidebar.MenuButton>
							</Sidebar.MenuItem>
						{/each}
					</Sidebar.Menu>
				</Sidebar.Group>
			{/each}
		</nav>
	</Sidebar.Content>
	<Sidebar.Rail />
</Sidebar.Root>
