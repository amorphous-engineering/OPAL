<script lang="ts">
	import * as Sidebar from '#lib/components/ui/sidebar/index.js';
	import { page } from '$app/state';
	import { NAV, isActive } from '#lib/nav.js';
	import { session } from '#lib/session.svelte.js';
</script>

<Sidebar.Root collapsible="offcanvas">
	<!-- The wordmark and build live in the header bar (VersionBadge), visible
	     whether or not the sidebar is open. This row keeps the nav aligned. -->
	<Sidebar.Header class="h-11 border-b border-sidebar-border"></Sidebar.Header>
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
