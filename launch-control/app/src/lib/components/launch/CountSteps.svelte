<script lang="ts">
	// The countdown as the execution of its procedure: done steps struck with who and when, the
	// current step open with its callouts and the one move it waits on.
	import { tick } from 'svelte';
	import { opalHref } from '#lib/opal/link.js';
	import { cn } from '#lib/utils.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { ActionLink, Section } from '#lib/components/opal/index.js';
	import { tTime, type CountStep, type LaunchSim } from '#lib/launch/sim.svelte.js';

	let { sim }: { sim: LaunchSim } = $props();

	const EXECUTION = 'WO-0041';
	// These steps close through the controls for the move itself, not through this key.
	const closers: Record<number, string> = { 7: 'RESUME COUNT', 9: 'ARM', 10: 'FIRE' };
	const rank = { warning: 0, caution: 1, note: 2 } as const;

	const current = $derived(sim.current);
	const hhmmss = (at?: string) => (at ? `${at.slice(11, 19)}Z` : '');
	const callouts = (s: CountStep) =>
		[...(s.callouts ?? [])].sort((a, b) => rank[a.kind] - rank[b.kind]);
	const issueHref = (s: CountStep) =>
		opalHref(`/issues/new?title=&execution=${EXECUTION}&step=${s.n}`);

	let list = $state<HTMLElement>();
	$effect(() => {
		const n = current?.n;
		if (n === undefined) return;
		void tick().then(() =>
			list?.querySelector(`[data-step="${n}"]`)?.scrollIntoView({ block: 'nearest' })
		);
	});
</script>

{#snippet label(kind: 'warning' | 'caution' | 'note')}
	<span
		class={cn(
			'mt-px border py-0.5 text-center font-mono text-xs font-bold tracking-wide uppercase',
			kind === 'warning' && 'border-error-fill bg-error-fill text-error-on',
			kind === 'caution' && 'border-warn-fill bg-warn-fill text-warn-on',
			kind === 'note' && 'border-dotted border-foreground text-foreground'
		)}>{kind}</span
	>
{/snippet}

<Section title="Countdown">
	{#snippet actions()}
		<ActionLink href={opalHref('/procedures?q=PROC-0012')} target="_blank" rel="noopener"
			>PROC-0012 rev C</ActionLink
		>
	{/snippet}
	<div bind:this={list} class="max-h-[32rem] overflow-y-auto">
		{#each sim.steps as step (step.n)}
			{@const done = !!step.doneBy}
			{@const cur = current === step}
			<div
				data-step={step.n}
				class={cn('border-b border-dotted last:border-b-0', cur && 'border-y border-solid')}
			>
				<div
					class={cn(
						'flex min-h-8 items-center gap-x-2 px-3 py-1',
						!done && !cur && 'text-foreground'
					)}
				>
					<span class="w-10 shrink-0 font-mono text-xs font-medium tabular-nums"
						><span class={cn(cur && '-ml-1 bg-foreground px-1 py-px font-semibold text-background')}
							>{step.n}</span
						></span
					>
					<span
						class={cn(
							'min-w-0 flex-1 truncate text-sm',
							done && 'text-muted-foreground line-through',
							cur && 'font-semibold'
						)}>{step.title}</span
					>
					{#if done}
						{#if step.captured}
							<span class="min-w-0 truncate font-mono text-xs">{step.captured}</span>
						{/if}
						<span class="shrink-0 font-mono text-xs whitespace-nowrap text-muted-foreground">
							{step.doneBy}
							<time datetime={step.doneAt}>{hhmmss(step.doneAt)}</time>
						</span>
					{:else if step.notBefore !== undefined}
						<span class="shrink-0 font-mono text-xs whitespace-nowrap text-muted-foreground"
							>{tTime(step.notBefore)}</span
						>
					{/if}
				</div>
				{#if cur}
					<div class="grid gap-2 bg-background px-3 py-2">
						{#each callouts(step) as c, i (i)}
							<p
								role="note"
								class="m-0 grid grid-cols-[5.5rem_minmax(0,1fr)] items-start gap-x-2.5 text-step"
							>
								{@render label(c.kind)}
								<span class="whitespace-pre-wrap">{c.text}</span>
							</p>
						{/each}
						<div class="flex flex-wrap items-center gap-x-3 gap-y-1">
							{#if closers[step.n]}
								<span class="font-mono text-xs text-muted-foreground"
									>Closes with {closers[step.n]}</span
								>
							{:else if sim.stepReady(step)}
								<Button onclick={() => sim.completeStep()}>COMPLETE STEP</Button>
							{:else}
								<Button disabled>COMPLETE STEP</Button>
								<span class="text-sm text-muted-foreground">{sim.stepBlock(step)}</span>
							{/if}
							<ActionLink href={issueHref(step)} target="_blank" rel="noopener" class="ml-auto"
								>RAISE ISSUE</ActionLink
							>
						</div>
					</div>
				{/if}
			</div>
		{/each}
	</div>
</Section>
