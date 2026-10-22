export interface LabelSpec {
	key: string;
	/** The identifier the label exists to carry: OPAL number or part number. */
	primary: string;
	/** Name of the part. */
	name: string;
	/** Part number line under the identifier (inventory labels). */
	secondary?: string | null;
	/** Facts: LOT, location, quantity, expiry. Dropped on compact stock. */
	facts?: string[];
	/** Register footer: tier, unit, tracking. Dropped on compact stock. */
	footer?: string | null;
	/** State word printed at the right of the footer (DRAFT). */
	state?: string | null;
	qr: string;
}
