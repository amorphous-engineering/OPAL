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
	private resolver: ((ok: boolean) => void) | null = null;

	ask(options: ConfirmOptions): Promise<boolean> {
		this.resolver?.(false);
		this.options = options;
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
