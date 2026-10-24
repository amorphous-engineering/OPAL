<script lang="ts">
	// + CAUTION / + INFO: append an empty callout to the step and focus its box.
	import * as Toolbar from '#lib/components/ui/toolbar/index.js';
	import { useDoc } from '../controller.js';
	import type { Callout, DocStep } from '../types.js';

	let { step }: { step: DocStep } = $props();
	const au = useDoc().author!;

	function add(kind: Callout['kind']) {
		const list = step.callouts ?? [];
		const idx = list.length;
		au.edit(step, { callouts: [...list, { kind, text: '' }] });
		setTimeout(() => {
			document.getElementById(`callout-${step.order}-${idx}`)?.focus();
		}, 40);
	}
</script>

<Toolbar.Button size="sm" class="font-mono" onclick={() => add('caution')}>+ CAUTION</Toolbar.Button
>
<Toolbar.Button size="sm" class="font-mono" onclick={() => add('info')}>+ INFO</Toolbar.Button>
