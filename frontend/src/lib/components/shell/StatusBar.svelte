<script lang="ts">
	// The bottom status line: server state, the live database file, and the clock in the user's
	// chosen zone (local or UTC), labelled.
	import type { Health } from '@opal/shared';
	import { ApiError, opal } from '#lib/api.js';
	import { clock, iso, zoneLabel } from '#lib/format.js';
	let { dbPath }: { dbPath: string } = $props();

	type State = 'READY' | 'DEGRADED' | 'DISCONNECTED';
	let status = $state<State>('READY');
	let reason = $state('');

	let at = $state(new Date());
	const now = $derived(clock(at));
	const zone = $derived(zoneLabel(at));

	$effect(() => {
		const timer = setInterval(() => (at = new Date()), 1000);
		return () => clearInterval(timer);
	});

	// A server that does not answer in this time counts as gone.
	const TIMEOUT_MS = 5_000;
	const timed = opal.using((input, init) =>
		fetch(input, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) })
	);

	function show(h: Health) {
		// An answer of another shape (an older server) still means a server answered.
		if (!Array.isArray(h?.checks)) {
			status = 'DEGRADED';
			reason = 'Unexpected health answer';
			return;
		}
		const failed = h.checks.filter((c) => !c.ok);
		status = h.status === 'ok' ? 'READY' : 'DEGRADED';
		reason = failed.map((c) => `${c.name}: ${c.detail ?? 'failed'}`).join(', ');
	}

	async function poll() {
		if (document.visibilityState !== 'visible') return;
		let h: Health;
		try {
			h = await timed.platform.health({});
		} catch (e) {
			// The client turns a network failure into a 503; a proxy with no server behind it
			// answers 502, 503 or 504. Any other error means OPAL answered, but badly.
			const gone = !(e instanceof ApiError) || [502, 503, 504].includes(e.status);
			status = gone ? 'DISCONNECTED' : 'DEGRADED';
			reason = e instanceof Error ? e.message : '';
			return;
		}
		show(h);
	}

	$effect(() => {
		void poll();
		const timer = setInterval(poll, 10_000);
		const offline = () => ((status = 'DISCONNECTED'), (reason = 'The browser is offline'));
		document.addEventListener('visibilitychange', poll);
		window.addEventListener('online', poll);
		window.addEventListener('offline', offline);
		return () => {
			clearInterval(timer);
			document.removeEventListener('visibilitychange', poll);
			window.removeEventListener('online', poll);
			window.removeEventListener('offline', offline);
		};
	});

	const tone: Record<State, string> = {
		READY: 'text-ok',
		DEGRADED: 'text-warn',
		DISCONNECTED: 'text-error'
	};
</script>

<footer
	class="sticky bottom-0 z-30 grid h-6 grid-cols-[minmax(0,1fr)_minmax(0,auto)_minmax(0,1fr)] items-center gap-4 border-t border-border bg-muted px-3 font-mono text-xs text-muted-foreground"
>
	<span class={['min-w-0 truncate', tone[status]]} title={reason || undefined}>
		STATUS: {status}{#if reason}<span class="ml-2 text-muted-foreground">{reason}</span>{/if}
	</span>
	<!-- Equal side columns keep the path centered. rtl: a long path loses its start, so the
	     file name stays visible. -->
	<span class="min-w-0 truncate text-center [direction:rtl]" title={dbPath}>
		<bdi>DB: {dbPath}</bdi>
	</span>
	<time class="justify-self-end whitespace-nowrap" datetime={iso(at)} title={iso(at)}
		>{now} {zone}</time
	>
</footer>
