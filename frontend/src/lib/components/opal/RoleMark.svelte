<script lang="ts">
	// The role that does a step: its letters in a square of the role's colour. The letters carry the
	// meaning; the colour lets the people at work follow their role down the page. A role that no
	// longer exists keeps its letters in an outline.
	import type { RoleColor, RoleMark } from '@opal/shared';
	import { cn } from '#lib/utils.js';

	let { mark, class: className }: { mark: RoleMark; class?: string } = $props();

	const FILL: Record<RoleColor, string> = {
		purple: 'bg-role-purple',
		teal: 'bg-role-teal',
		brown: 'bg-role-brown',
		magenta: 'bg-role-magenta',
		slate: 'bg-role-slate'
	};
</script>

<span
	class={cn(
		'role-mark inline-flex h-[18px] min-w-[26px] shrink-0 items-center justify-center px-1 font-mono text-xs leading-none font-bold tracking-wide',
		mark.color ? [FILL[mark.color], 'text-role-on'] : 'border border-current',
		className
	)}
	title={mark.name}
	aria-label={mark.name}
	data-role-mark={mark.code}>{mark.code}</span
>
