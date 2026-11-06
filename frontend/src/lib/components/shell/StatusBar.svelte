<script lang="ts">
	// The bottom status line: the connection ticker, the live database file and the clock in the
	// user's chosen zone (local or UTC), labelled. A healthy connection stays visible, because a
	// missing indicator proves nothing.
	import { refreshAll } from '$app/navigation';
	import type { Health } from '@opal/shared';
	import { ApiError, opal } from '#lib/api.js';
	import { clock, iso, zoneLabel } from '#lib/format.js';
	import { onServerEvent, onStreamChange } from './events.js';
	let { dbPath }: { dbPath: string } = $props();

	// Whether the server answers right now.
	let reachable = $state(true);
	let offlineWhy = $state('');
	// Whether live updates are arriving right now.
	let streaming = $state(true);
	// A failed health check while the server still answers.
	let failing = $state('');
	// Any break stays on the ticker until someone presses it, however short it was: what is on
	// screen may have missed something. This is the page's master caution.
	let droppedAt = $state<Date | null>(null);
	let backAt = $state<Date | null>(null);

	type Ticker = 'ONLINE' | 'STALE' | 'OFFLINE';
	const ticker = $derived<Ticker>(
		!reachable ? 'OFFLINE' : droppedAt || !streaming || failing ? 'STALE' : 'ONLINE'
	);
	const reason = $derived.by(() => {
		if (!reachable) return offlineWhy;
		if (failing) return failing;
		if (!droppedAt) return '';
		const time = (d: Date) => clock(d).slice(-8);
		return `Dropped ${time(droppedAt)}${backAt ? `, back ${time(backAt)}` : ''}`;
	});

	let at = $state(new Date());
	const now = $derived(clock(at));
	const zone = $derived(zoneLabel(at));

	$effect(() => {
		const timer = setInterval(() => (at = new Date()), 1000);
		return () => clearInterval(timer);
	});

	function dropped() {
		// Keep the first drop until it is acknowledged, unless the line had come back since.
		if (!droppedAt || backAt) droppedAt = new Date();
		backAt = null;
	}

	function recovered() {
		if (droppedAt && !backAt && reachable && streaming) backAt = new Date();
	}

	function setReachable(up: boolean, why = '') {
		offlineWhy = why;
		if (reachable === up) return;
		reachable = up;
		if (up) recovered();
		else dropped();
	}

	function setStreaming(up: boolean) {
		if (streaming === up) return;
		streaming = up;
		if (up) recovered();
		else dropped();
	}

	// A server that does not answer in this time counts as gone.
	const TIMEOUT_MS = 5_000;
	const timed = opal.using((input, init) =>
		fetch(input, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) })
	);

	function show(h: Health) {
		setReachable(true);
		// An answer of another shape (an older server) still means a server answered.
		if (!Array.isArray(h?.checks)) {
			failing = 'Unexpected health answer';
			return;
		}
		const failed = h.checks.filter((c) => !c.ok);
		failing =
			h.status === 'ok' ? '' : failed.map((c) => `${c.name}: ${c.detail ?? 'failed'}`).join(', ');
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
			const why = e instanceof Error ? e.message : '';
			if (gone) setReachable(false, why);
			else {
				setReachable(true);
				failing = why;
			}
			return;
		}
		show(h);
	}

	// Pressing STALE takes the caution: reload what is on screen and start clean.
	async function acknowledge() {
		droppedAt = null;
		backAt = null;
		await refreshAll();
		void poll();
	}

	$effect(() => {
		void poll();
		const timer = setInterval(poll, 10_000);
		const offline = () => setReachable(false, 'The browser is offline');
		document.addEventListener('visibilitychange', poll);
		window.addEventListener('online', poll);
		window.addEventListener('offline', offline);
		const stopStream = onStreamChange(setStreaming);
		// The ticker needs the stream open even on a page nothing else listens on.
		const stopEvents = onServerEvent('heartbeat', () => {});
		return () => {
			clearInterval(timer);
			document.removeEventListener('visibilitychange', poll);
			window.removeEventListener('online', poll);
			window.removeEventListener('offline', offline);
			stopStream();
			stopEvents();
		};
	});

	const tickerClass = 'inline-flex h-[18px] items-center px-1.5 font-semibold tracking-wide';
</script>

<footer
	class="sticky bottom-0 z-30 grid h-6 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-4 border-t border-border bg-muted px-2 font-mono text-xs"
>
	<span class="flex items-center gap-2 whitespace-nowrap" role="status" title={reason || undefined}>
		{#if ticker === 'ONLINE'}
			<span class="{tickerClass} bg-ok-fill text-ok-on">ONLINE</span>
		{:else if ticker === 'STALE'}
			<button
				type="button"
				class="{tickerClass} cursor-pointer bg-warn-fill text-warn-on shadow-key active:shadow-none"
				onclick={acknowledge}>STALE</button
			>
		{:else}
			<span class="{tickerClass} bg-error-fill text-error-on">OFFLINE</span>
		{/if}
		{#if reason}<span class="max-w-[40vw] truncate">{reason}</span>{/if}
	</span>
	<!-- rtl: a long path loses its start, so the file name stays visible. -->
	<span class="min-w-0 truncate text-center text-quiet [direction:rtl]" title={dbPath}>
		<bdi>DB: {dbPath}</bdi>
	</span>
	<time class="justify-self-end whitespace-nowrap" datetime={iso(at)} title={iso(at)}
		>{now} {zone}</time
	>
</footer>
