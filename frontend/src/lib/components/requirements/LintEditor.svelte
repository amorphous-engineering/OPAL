<script lang="ts">
	// Shall-statement editor: lint-as-you-type. An overlay under the transparent
	// textarea draws the underlines; the findings list below says what each is.
	import { onDestroy } from 'svelte';
	import { api } from '#lib/api.js';
	import { cn } from '#lib/utils.js';
	import { lintSegments, FIELD_RULES } from './lint.js';
	import type { Finding } from './types.js';

	let {
		value = $bindable(''),
		findings: initial = [],
		id,
		placeholder,
		onsave,
		required = false
	}: {
		value?: string;
		findings?: Finding[];
		id?: string;
		placeholder?: string;
		/** Called on blur with the current text. */
		onsave?: (text: string) => void;
		required?: boolean;
	} = $props();

	let live = $state<Finding[] | null>(null);
	let timer: ReturnType<typeof setTimeout> | undefined;
	let seq = 0;

	const own = (list: Finding[]) => list.filter((f) => !FIELD_RULES.has(f.name));
	const shown = $derived(own(live ?? initial));
	const segments = $derived(lintSegments(value, shown));

	function oninput() {
		clearTimeout(timer);
		const text = value;
		if (!text.trim()) {
			live = [];
			return;
		}
		const mine = ++seq;
		timer = setTimeout(async () => {
			try {
				const r = await api.post<{ findings: Finding[] }>('/requirements/lint', {
					statement: text
				});
				if (mine === seq) live = r.findings;
			} catch {
				/* lint is advisory; the baseline gate still enforces */
			}
		}, 250);
	}

	onDestroy(() => clearTimeout(timer));

	// Collapse repeats of one message into "message (xN)".
	const summary = $derived.by(() => {
		const out: { f: Finding; n: number }[] = [];
		for (const f of shown) {
			const e = out.find((x) => x.f.severity === f.severity && x.f.message === f.message);
			if (e) e.n++;
			else out.push({ f, n: 1 });
		}
		return out;
	});
</script>

<div>
	<div class="relative">
		<div
			aria-hidden="true"
			class="pointer-events-none absolute inset-0 overflow-hidden rounded-md border border-transparent px-2.5 py-2 font-mono text-xs break-words whitespace-pre-wrap text-transparent"
		>
			{#each segments as s, i (i)}{#if s.severity}<span
						class={cn(
							'underline decoration-wavy underline-offset-2',
							s.severity === 'block' ? 'decoration-error' : 'decoration-warn'
						)}>{s.text}</span
					>{:else}{s.text}{/if}{/each}
		</div>
		<textarea
			{id}
			bind:value
			{oninput}
			onblur={() => onsave?.(value)}
			{placeholder}
			{required}
			rows="3"
			class="relative block field-sizing-content min-h-16 w-full rounded-md border border-input bg-transparent px-2.5 py-2 font-mono text-xs break-words whitespace-pre-wrap outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50"
		></textarea>
	</div>
	{#if summary.length}
		<ul class="mt-1 grid grid-cols-1 gap-0.5 font-mono text-xs" aria-label="Lint findings">
			{#each summary as { f, n } (f.severity + f.message)}
				<li class={f.severity === 'block_baseline' ? 'text-error' : 'text-warn'}>
					{f.rule}
					<span class="text-foreground">{f.message}{n > 1 ? ` (×${n})` : ''}</span>
				</li>
			{/each}
		</ul>
	{/if}
</div>
