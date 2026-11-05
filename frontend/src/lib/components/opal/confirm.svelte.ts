/**
 * Imperative confirmation. Consequence sentences live only here and in errors
 * (voice rule 2): `if (await confirm({ title, body, action: 'DELETE' })) ...`
 */
export interface ConfirmOptions {
	title: string;
	body?: string;
	action?: string;
	destructive?: boolean;
	/** Require typing this text to enable the action (irreversible operations). */
	typeToConfirm?: string;
}

class ConfirmState {
	open = $state(false);
	options = $state<ConfirmOptions>({ title: '' });
	/** The dialog asks for a reason and will not confirm without one. */
	needsReason = $state(false);
	reason = $state('');
	private resolver: ((ok: boolean) => void) | null = null;

	ask(options: ConfirmOptions, needsReason = false): Promise<boolean> {
		this.resolver?.(false);
		this.options = options;
		this.needsReason = needsReason;
		this.reason = '';
		this.open = true;
		return new Promise((resolve) => (this.resolver = resolve));
	}

	settle(ok: boolean) {
		this.open = false;
		this.resolver?.(ok);
		this.resolver = null;
	}
}

export const confirmState = new ConfirmState();
export const confirm = (options: ConfirmOptions) => confirmState.ask(options);

/**
 * A strike: void, cancel, close short. The reason goes on the record, so the dialog will not
 * confirm without one. Returns the reason, or null when the person backs out.
 */
export async function askReason(options: ConfirmOptions): Promise<string | null> {
	const ok = await confirmState.ask(options, true);
	return ok ? confirmState.reason.trim() : null;
}
