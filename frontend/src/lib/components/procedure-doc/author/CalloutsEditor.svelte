<script lang="ts">
	// A step's callouts as the operator sees them (red CAUTION, blue INFO), each an
	// editable box with a kind toggle and a remove control. Adding lives in CalloutAdd.
	import { Button } from '#lib/components/ui/button/index.js';
	import { cn } from '#lib/utils.js';
	import { useDoc } from '../controller.js';
	import type { Callout, DocStep } from '../types.js';

	let { step }: { step: DocStep } = $props();
	const au = useDoc().author!;
	const list = $derived(step.callouts ?? []);

	function set(next: Callout[]) {
		au.edit(step, { callouts: next });
	}
</script>

{#if list.length}
	<div class="grid grid-cols-1 gap-2">
		{#each list as c, i (i)}
			{@const caution = c.kind === 'caution'}
			<div
				role="note"
				class={cn(
					'rounded-lg border px-3 py-2 text-xs',
					caution ? 'border-error/50 bg-error-muted' : 'border-info/50 bg-info-muted'
				)}
			>
				<div class="mb-0.5 flex items-center justify-between gap-2">
					<button
						type="button"
						class={cn('label cursor-pointer hover:underline', caution ? 'text-error' : 'text-info')}
						title={caution ? 'Change to info' : 'Change to caution'}
						onclick={() =>
							set(list.map((x, j) => (j === i ? { ...x, kind: caution ? 'info' : 'caution' } : x)))}
						>{caution ? 'Caution' : 'Info'}</button
					>
					<Button
						variant="ghost"
						size="xs"
						class="h-5 px-1.5 font-mono text-xs"
						aria-label="Remove callout"
						onclick={() => set(list.filter((_, j) => j !== i))}>×</Button
					>
				</div>
				<textarea
					id={`callout-${step.order}-${i}`}
					rows="1"
					class="field-sizing-content min-h-6 w-full resize-none border border-transparent bg-transparent px-1 text-sm leading-relaxed whitespace-pre-wrap text-foreground placeholder:text-muted-foreground hover:border-border focus:border-ring focus:bg-background focus:outline-none"
					placeholder={caution ? 'Hazard text' : 'Note text'}
					value={c.text}
					onkeydown={(e) => e.stopPropagation()}
					oninput={(e) => {
						const text = e.currentTarget.value;
						set(list.map((x, j) => (j === i ? { ...x, text } : x)));
					}}></textarea>
			</div>
		{/each}
	</div>
{/if}
