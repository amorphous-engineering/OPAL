/** Search registrations for tables the platform area can see today. Areas register the rest. */
import { part } from '../../db/schema/index.ts';
import { registerSearchable } from './search.ts';

registerSearchable({
	type: 'part',
	table: part,
	columns: [part.name, part.internalPn, part.externalPn, part.description],
	identifier: part.internalPn,
	hit: (r) => ({ label: r.name, sublabel: r.internalPn || r.externalPn, href: `/parts/${r.id}`, status: r.state })
});
