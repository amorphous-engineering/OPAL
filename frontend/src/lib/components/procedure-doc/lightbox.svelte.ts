/** Image lightbox state. Mount one <Lightbox /> in the page; any component opens it. */
class LightboxState {
	src = $state<string | null>(null);
	caption = $state<string | null>(null);

	open(src: string, caption?: string | null) {
		this.src = src;
		this.caption = caption ?? null;
	}

	close() {
		this.src = null;
		this.caption = null;
	}
}

export const lightbox = new LightboxState();

/** Download URL for an attachment (images, files). */
export const attachmentUrl = (id: number) => `/api/attachments/${id}/download`;
