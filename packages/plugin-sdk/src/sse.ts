/** Incremental parser for a server-sent event stream. Chunks may split anywhere. */
export class SseParser {
	private buf = '';
	private data: string[] = [];

	/** Feed text; returns the `data` payload of every event that the text completed. */
	push(chunk: string): string[] {
		this.buf += chunk;
		const out: string[] = [];
		let nl: number;
		while ((nl = this.buf.search(/\r\n|\n|\r/)) >= 0) {
			const m = /^(\r\n|\n|\r)/.exec(this.buf.slice(nl))!;
			// A lone CR at the end may be the first half of CRLF; wait for more text.
			if (m[0] === '\r' && nl + 1 === this.buf.length) break;
			const line = this.buf.slice(0, nl);
			this.buf = this.buf.slice(nl + m[0].length);
			if (line === '') {
				if (this.data.length) out.push(this.data.join('\n'));
				this.data = [];
			} else if (line.startsWith(':')) {
				// comment
			} else {
				const i = line.indexOf(':');
				const field = i < 0 ? line : line.slice(0, i);
				let value = i < 0 ? '' : line.slice(i + 1);
				if (value.startsWith(' ')) value = value.slice(1);
				if (field === 'data') this.data.push(value);
			}
		}
		return out;
	}
}
