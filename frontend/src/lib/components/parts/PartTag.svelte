<script lang="ts">
	// The part tag: one identity, one rendering. Forming on the create form,
	// current on the edit form, and the printed label. If the screen tag and
	// the label ever differ, that is a bug by definition.
	import { cn } from '#lib/utils.js';

	let {
		pn,
		name,
		tierLevel,
		tierName,
		tierCode,
		uom = 'ea',
		tracking,
		state = 'draft',
		qr,
		print = false,
		class: className
	}: {
		pn: string | null | undefined;
		name: string;
		tierLevel: number | null;
		tierName?: string | null;
		/** Tier code; set apart inside the PN when it is a delimited segment. */
		tierCode?: string | null;
		uom?: string;
		tracking?: string | null;
		state?: 'draft' | 'active' | 'obsolete';
		qr?: string | null;
		print?: boolean;
		class?: string;
	} = $props();

	const segments = $derived.by(() => {
		if (!pn || !tierCode) return null;
		const esc = tierCode.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const m = new RegExp(`(?<![A-Za-z0-9])${esc}(?![A-Za-z0-9])`).exec(pn);
		return m ? ([pn.slice(0, m.index), m[0], pn.slice(m.index + m[0].length)] as const) : null;
	});

	const meta = $derived(
		[
			tierLevel === null ? '—' : `T${tierLevel}${tierName ? ` ${tierName.toUpperCase()}` : ''}`,
			uom.toUpperCase(),
			tracking === 'serialized' ? 'SER' : tracking === 'bulk' ? 'BULK' : null
		]
			.filter(Boolean)
			.join(' · ')
	);
</script>

<div
	class={cn(
		'flex flex-col gap-2 border-2 p-3 font-mono',
		print ? 'w-[360px] border-black bg-white text-black' : 'border-foreground bg-card',
		className
	)}
>
	<div class="flex items-start justify-between gap-3">
		<div class="min-w-0">
			<div class="text-xl leading-tight font-bold tracking-wide break-all">
				{#if segments}{segments[0]}<span class={print ? 'underline' : 'text-info'}
						>{segments[1]}</span
					>{segments[2]}{:else if pn}{pn}{:else}<span class="text-muted-foreground">· · · · ·</span
					>{/if}
			</div>
			<div class="mt-1 min-h-4 font-sans text-sm break-words">{name}</div>
		</div>
		<div
			class={cn(
				'flex size-20 shrink-0 items-center justify-center border',
				print ? 'border-black' : 'border-border'
			)}
		>
			{#if qr}
				<img src={qr} alt="QR code" class="size-full" />
			{:else}
				<span class="text-xs text-muted-foreground">QR</span>
			{/if}
		</div>
	</div>
	<div
		class={cn(
			'flex items-center justify-between border-t pt-2 text-[11px] tracking-wider',
			print ? 'border-black' : 'border-border'
		)}
	>
		<span>{meta}</span>
		<span
			class={cn(
				'font-semibold',
				!print &&
					(state === 'draft'
						? 'text-warn'
						: state === 'obsolete'
							? 'text-error'
							: 'text-muted-foreground')
			)}>{state.toUpperCase()}</span
		>
	</div>
</div>
