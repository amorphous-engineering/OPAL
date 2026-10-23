<script lang="ts">
	// A scenario textarea with inline lint: flagged runs are underlined in an
	// overlay (the server computes the runs), and each distinct finding is
	// listed beneath. Lint is advisory here; it never interrupts typing.
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { api } from '#lib/api.js';
	import { cn } from '#lib/utils.js';
	import type { LintSegment } from './types.js';

	let {
		value = $bindable(''),
		field,
		id,
		placeholder,
		disabled = false,
		onkeydown,
		onblur
	}: {
		value?: string;
		field: 'condition' | 'departure' | 'consequence';
		id?: string;
		placeholder?: string;
		disabled?: boolean;
		onkeydown?: (e: KeyboardEvent) => void;
		onblur?: () => void;
	} = $props();

	let segments = $state<LintSegment[]>([]);
	let linted = $state('');
	let seq = 0;

	// Re-lint after a pause in typing; until then the overlay mirrors the text
	// unflagged so underlines never sit on the wrong characters.
	$effect(() => {
		const text = value ?? '';
		if (!text.trim()) {
			segments = [];
			linted = '';
			return;
		}
		const mine = ++seq;
		const timer = setTimeout(async () => {
			try {
				const r = await api.post<{ segments: Record<string, LintSegment[]> }>('/risks/lint', {
					[field]: text
				});
				if (mine === seq) {
					segments = r.segments[field] ?? [];
					linted = text;
				}
			} catch {
				/* advisory */
			}
		}, 400);
		return () => clearTimeout(timer);
	});

	const current = $derived(
		linted === (value ?? '') ? segments : [{ text: value ?? '', severity: null, findings: [] }]
	);

	const messages = $derived.by(() => {
		const out: { rule: string; message: string; severity: string }[] = [];
		for (const s of segments)
			for (const f of s.findings)
				if (!out.some((m) => m.rule === f.rule && m.message === f.message))
					out.push({ ...f, severity: s.severity ?? 'warn' });
		return out;
	});
</script>

<div class="grid grid-cols-1">
	<div
		aria-hidden="true"
		class="pointer-events-none col-start-1 row-start-1 min-h-12 overflow-hidden border border-transparent px-2.5 py-2 font-mono text-xs break-words whitespace-pre-wrap text-transparent"
	>
		{#each current as s, i (i)}{#if s.severity}<span
					class={cn(
						'underline decoration-wavy underline-offset-2',
						s.severity === 'block' ? 'decoration-error' : 'decoration-warn'
					)}>{s.text}</span
				>{:else}{s.text}{/if}{/each}
	</div>
	<Textarea
		{id}
		bind:value
		{placeholder}
		{disabled}
		{onkeydown}
		{onblur}
		class="col-start-1 row-start-1 min-h-12 resize-none bg-transparent font-mono dark:bg-transparent"
	/>
</div>
{#if messages.length}
	<ul class="mt-1 grid grid-cols-1 gap-0.5 font-mono text-xs">
		{#each messages as m (m.rule + m.message)}
			<li class={m.severity === 'block' ? 'text-error' : 'text-warn'}>
				{m.rule} · {m.message}
			</li>
		{/each}
	</ul>
{/if}
