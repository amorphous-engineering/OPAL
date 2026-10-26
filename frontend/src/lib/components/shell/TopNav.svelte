<script lang="ts">
	// Primary navigation in the header bar: Overview plus one dropdown per NAV group.
	// A group button shows the active state when the current page is inside it. Below
	// 900px the groups fold into a single MENU dropdown. NAV (lib/nav.ts) is the one list.
	import CaretDown from 'phosphor-svelte/lib/CaretDown';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import { page } from '$app/state';
	import { ACCOUNT_GROUP, NAV, PROJECTS_NAV, isActive } from '#lib/nav.js';
	import { cn } from '#lib/utils.js';

	const groups = NAV.filter((g) => g.label !== ACCOUNT_GROUP);
	const path = $derived(page.url.pathname);
	const groupActive = (g: (typeof NAV)[number]) => g.items.some((i) => isActive(path, i.href));

	const trigger =
		'inline-flex h-7 items-center gap-1 rounded-md border border-transparent px-2 font-mono text-xs font-medium tracking-wider uppercase hover:bg-accent data-[state=open]:bg-accent';
</script>

<nav aria-label="Primary" class="flex shrink-0 items-center gap-0.5">
	<!-- Wide: Overview + a dropdown per group -->
	<div class="hidden items-center gap-0.5 min-[900px]:flex">
		<a
			href="/"
			class={cn(trigger, path === '/' && 'border-border bg-accent text-info')}
			aria-current={path === '/' ? 'page' : undefined}>Overview</a
		>
		<!-- added by projects -->
		<a
			href={PROJECTS_NAV.href}
			class={cn(trigger, isActive(path, PROJECTS_NAV.href) && 'border-border bg-accent text-info')}
			aria-current={isActive(path, PROJECTS_NAV.href) ? 'page' : undefined}>{PROJECTS_NAV.label}</a
		>
		{#each groups as g (g.label)}
			<DropdownMenu.Root>
				<DropdownMenu.Trigger class={cn(trigger, groupActive(g) && 'border-border text-info')}>
					{g.label}<CaretDown weight="bold" class="size-3" aria-hidden="true" />
				</DropdownMenu.Trigger>
				<DropdownMenu.Content align="start" class="min-w-40">
					{#each g.items as item (item.href)}
						<DropdownMenu.Item>
							{#snippet child({ props })}
								<a
									href={item.href}
									{...props}
									class={cn(props.class as string, isActive(path, item.href) && 'text-info')}
									aria-current={isActive(path, item.href) ? 'page' : undefined}>{item.label}</a
								>
							{/snippet}
						</DropdownMenu.Item>
					{/each}
				</DropdownMenu.Content>
			</DropdownMenu.Root>
		{/each}
	</div>

	<!-- Narrow: everything behind one MENU -->
	<div class="min-[900px]:hidden">
		<DropdownMenu.Root>
			<DropdownMenu.Trigger class={cn(trigger, 'border-border')}>
				Menu<CaretDown weight="bold" class="size-3" aria-hidden="true" />
			</DropdownMenu.Trigger>
			<DropdownMenu.Content align="start" class="max-h-[80svh] min-w-48 overflow-y-auto">
				<DropdownMenu.Item>
					{#snippet child({ props })}
						<a href="/" {...props} aria-current={path === '/' ? 'page' : undefined}>Overview</a>
					{/snippet}
				</DropdownMenu.Item>
				<!-- added by projects -->
				<DropdownMenu.Item>
					{#snippet child({ props })}
						<a
							href={PROJECTS_NAV.href}
							{...props}
							aria-current={isActive(path, PROJECTS_NAV.href) ? 'page' : undefined}
							>{PROJECTS_NAV.label}</a
						>
					{/snippet}
				</DropdownMenu.Item>
				{#each groups as g (g.label)}
					<DropdownMenu.Separator />
					<DropdownMenu.Label class="label">{g.label}</DropdownMenu.Label>
					{#each g.items as item (item.href)}
						<DropdownMenu.Item>
							{#snippet child({ props })}
								<a
									href={item.href}
									{...props}
									class={cn(props.class as string, isActive(path, item.href) && 'text-info')}
									aria-current={isActive(path, item.href) ? 'page' : undefined}>{item.label}</a
								>
							{/snippet}
						</DropdownMenu.Item>
					{/each}
				{/each}
			</DropdownMenu.Content>
		</DropdownMenu.Root>
	</div>
</nav>
