<script lang="ts">
	import { BankKey, KeyBank } from '#lib/components/opal/index.js';
	// A step's callouts, each labelled as the operator sees it, in an editable box with a kind
	// toggle and a remove control. Pressing the label steps through warning, caution and info.
	// Adding lives in the step's ADD bank.
	import { cn } from '#lib/utils.js';
	import CalloutLabel from '../CalloutLabel.svelte';
	import { CALLOUT_LABEL, CALLOUT_ORDER } from '../callouts.js';
	import { useDoc } from '../controller.js';
	import type { Callout, DocStep } from '../types.js';

	let { step }: { step: DocStep } = $props();
	const au = useDoc().author!;
	const list = $derived(step.callouts ?? []);

	function set(next: Callout[]) {
		au.edit(step, { callouts: next });
	}

	const nextKind = (k: Callout['kind']) =>
		CALLOUT_ORDER[(CALLOUT_ORDER.indexOf(k) + 1) % CALLOUT_ORDER.length];

	/** What the author is asked to write, so the kind is picked by what can go wrong. */
	const PLACEHOLDER: Record<Callout['kind'], string> = {
		warning: 'Who can be hurt, and how to stay safe',
		caution: 'What can be damaged, and how to avoid it',
		info: 'Note text'
	};
</script>

{#if list.length}
	<div class="grid grid-cols-1 gap-2">
		{#each list as c, i (i)}
			{@const next = nextKind(c.kind)}
			<div role="note" class={cn('border border-dotted border-foreground px-3 py-2 text-xs')}>
				<div class="mb-0.5 flex items-center justify-between gap-2">
					<button
						type="button"
						class="w-[5.5rem] cursor-pointer hover:underline"
						title={`Change to ${CALLOUT_LABEL[next].toLowerCase()}`}
						onclick={() => set(list.map((x, j) => (j === i ? { ...x, kind: next } : x)))}
						><CalloutLabel kind={c.kind} /></button
					>
					<KeyBank label="Callout tools">
						<BankKey aria-label="Remove callout" onclick={() => set(list.filter((_, j) => j !== i))}
							>REMOVE</BankKey
						>
					</KeyBank>
				</div>
				<textarea
					id={`callout-${step.order}-${i}`}
					rows="1"
					class="field-sizing-content min-h-6 w-full resize-none border border-transparent bg-transparent px-1 text-sm leading-relaxed whitespace-pre-wrap text-foreground placeholder:text-muted-foreground hover:border-border focus:border-ring focus:bg-background focus:outline-none"
					placeholder={PLACEHOLDER[c.kind]}
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
