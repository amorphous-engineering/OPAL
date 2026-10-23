<script lang="ts">
	// Primary navigation in the header bar: Overview plus one dropdown per NAV group.
	// A group button shows the active state when the current page is inside it. Below
	// 900px the groups fold into a single MENU dropdown. NAV (lib/nav.ts) is the one list.
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import { page } from '$app/state';
	import { ACCOUNT_GROUP, NAV, isActive } from '#lib/nav.js';
	import { cn } from '#lib/utils.js';

	const groups = NAV.filter((g) => g.label !== ACCOUNT_GROUP);
	const path = $derived(page.url.pathname);
	const groupActive = (g: (typeof NAV)[number]) => g.items.some((i) => isActive(path, i.href));

	const trigger =
		'inline-flex h-(--control-md) items-center gap-1 rounded-md border border-transparent px-2 font-mono text-xs font-medium tracking-wider uppercase hover:bg-accent data-[state=open]:bg-accent';
</script>

<nav aria-label="Primary" class="flex shrink-0 items-center gap-0.5">
	<!-- Wide: Overview + a dropdown per group -->
	<div class="hidden items-center gap-0.5 min-[900px]:flex">
		<a
			href="/"
			class={cn(trigger, path === '/' && 'border-border bg-accent text-info')}
			aria-current={path === '/' ? 'page' : undefined}>Overview</a
		>
		{#each groups as g (g.label)}
			<DropdownMenu.Root>
				<DropdownMenu.Trigger class={cn(trigger, groupActive(g) && 'border-border text-info')}>
					{g.label}<span aria-hidden="true" class="text-xs">▾</span>
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
				Menu<span aria-hidden="true" class="text-xs">▾</span>
			</DropdownMenu.Trigger>
			<DropdownMenu.Content align="start" class="max-h-[80svh] min-w-48 overflow-y-auto">
				<DropdownMenu.Item>
					{#snippet child({ props })}
						<a href="/" {...props} aria-current={path === '/' ? 'page' : undefined}>Overview</a>
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
