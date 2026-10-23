/**
 * The draft as an operator sees it: the same document components in execute
 * mode over the editor's own objects, with every step pending and every control
 * inert. Nothing it does reaches the server.
 */
import { toast } from '#lib/components/opal/index.js';
import type { DocActions, DocController, DocStep } from '#lib/components/procedure-doc/index.js';

export class PreviewController implements DocController {
	readonly mode = 'execute' as const;
	viewerId = null;
	active = true;
	focusedOrder = $state<number | null>(null);
	claimedOrder = $state<number | null>(null);
	private closed = $state<Record<string, boolean>>({});
	private values = $state<Record<number, Record<string, unknown>>>({});

	isOpen(key: string) {
		return !this.closed[key];
	}
	toggle(key: string) {
		this.closed[key] = !this.closed[key];
	}
	setFocus(order: number) {
		this.focusedOrder = order;
	}
	fieldValue(step: DocStep, name: string) {
		return this.values[step.order]?.[name];
	}
	setField(step: DocStep, name: string, value: unknown) {
		(this.values[step.order] ??= {})[name] = value;
	}
	fieldErrors() {
		return {};
	}

	private inert = async () => {
		toast.info('Preview: nothing is recorded');
	};

	actions: DocActions = {
		claim: async (step) => {
			this.claimedOrder = step.order;
		},
		release: async () => {
			this.claimedOrder = null;
		},
		complete: this.inert,
		signoff: this.inert,
		skip: () => void this.inert(),
		raiseIssue: () => void this.inert()
	};
}
