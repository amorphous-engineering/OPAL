<script lang="ts">
	// A waived slot reads like the line its one person wrote on the form: why, who, when. No avatar
	// and no "Signed by": nobody signed it, and the reader must not take it for a signature.
	import { waivedText } from '@opal/shared';
	import { datetime, iso } from '#lib/format.js';
	import type { DocSignoff } from './types.js';

	let { waived }: { waived: NonNullable<DocSignoff['waived']> } = $props();
	const text = $derived(
		waivedText({ by: waived.by?.name ?? null, at: datetime(waived.at), reason: waived.reason })
	);
</script>

<span class="font-sans text-sm" title={iso(waived.at)} data-waived
	>{text.charAt(0).toUpperCase()}{text.slice(1)}</span
>
