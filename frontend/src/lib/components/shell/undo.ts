/**
 * Undo the signed-in user's most recent change (server window: one hour).
 * One flow for every entry point: the Ctrl/Cmd+Z shortcut and the audit page.
 */
import { invalidateAll } from '$app/navigation';
import { api, ApiError } from '#lib/api.js';
import { confirm, toast, toastError } from '#lib/components/opal/index.js';

interface UndoPreview {
	action: string;
	summary: string;
	timestamp: string;
	can_undo: boolean;
	reason: string | null;
}

let busy = false;

export async function undoLast(): Promise<void> {
	if (busy) return;
	busy = true;
	try {
		let preview: UndoPreview;
		try {
			preview = await api.get<UndoPreview>('/undo/last');
		} catch (e) {
			if (e instanceof ApiError && e.status === 404) {
				toast('Nothing to undo');
				return;
			}
			throw e;
		}
		if (!preview.can_undo) {
			toast.error(preview.reason ?? 'The last change cannot be undone');
			return;
		}
		const ok = await confirm({
			title: preview.summary,
			body: 'Reverts your most recent change.',
			action: 'UNDO'
		});
		if (!ok) return;
		const result = await api.post<{ summary: string }>('/undo/last');
		toast.success(result.summary);
		await invalidateAll();
	} catch (e) {
		toastError(e, 'Undo failed');
	} finally {
		busy = false;
	}
}
