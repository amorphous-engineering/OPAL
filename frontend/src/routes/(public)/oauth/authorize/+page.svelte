<script lang="ts">
	import { DetailRow, DetailTable, ErrorBanner } from '#lib/components/opal/index.js';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { ApiError, opal } from '#lib/api.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const q = page.url.searchParams;
	const request = {
		responseType: q.get('response_type') ?? '',
		clientId: q.get('client_id') ?? '',
		redirectUri: q.get('redirect_uri') ?? '',
		codeChallenge: q.get('code_challenge') ?? '',
		codeChallengeMethod: q.get('code_challenge_method') ?? '',
		...(q.get('state') !== null ? { state: q.get('state')! } : {})
	};

	let info = $state<{ clientName: string; redirectHost: string; denyUrl: string } | null>(null);
	let error = $state<string | null>(null);
	let busy = $state(false);

	onMount(async () => {
		try {
			const r = await opal.auth.oauth.describe(request);
			if (r.errorUrl) {
				window.location.href = r.errorUrl;
				return;
			}
			info = r;
		} catch (err) {
			error = err instanceof ApiError ? err.message : 'Could not read the request';
		}
	});

	async function approve() {
		busy = true;
		error = null;
		try {
			window.location.href = (await opal.auth.oauth.approve(request)).redirectTo;
		} catch (err) {
			error = err instanceof ApiError ? err.message : 'Could not approve the request';
			busy = false;
		}
	}
</script>

<svelte:head><title>Connect client · OPAL</title></svelte:head>

<h1 class="mb-4 text-lg font-semibold">Connect client</h1>

<ErrorBanner message={error} class="mb-3" />
{#if info}
	<DetailTable class="mb-3 border border-border">
		<DetailRow label="Client" value={info.clientName} />
		<DetailRow label="Returns to" value={info.redirectHost} mono />
		<DetailRow label="Account" value={data.user.username} mono />
	</DetailTable>
	<p class="mb-4 text-sm text-muted-foreground">
		The client gets the same access as this account. It cannot sign steps or do other actions that
		need a person.
	</p>
	<div class="flex gap-2">
		<Button onclick={approve} disabled={busy}>APPROVE</Button>
		<Button variant="outline" href={info.denyUrl} disabled={busy}>DENY</Button>
	</div>
{:else if !error}
	<Skeleton class="h-24" />
{/if}
