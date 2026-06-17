const KEYS = {
	anthropic: "fennec-vox:anthropic-key",
	openai: "fennec-vox:openai-key",
	elevenlabs: "fennec-vox:elevenlabs-key",
	google: "fennec-vox:google-key",
} as const;

export async function getCredentials(): Promise<{
	anthropicKey: string;
	openaiKey: string;
	elevenLabsKey: string;
	googleKey: string;
}> {
	return {
		anthropicKey: localStorage.getItem(KEYS.anthropic) ?? "",
		openaiKey: localStorage.getItem(KEYS.openai) ?? "",
		elevenLabsKey: localStorage.getItem(KEYS.elevenlabs) ?? "",
		googleKey: localStorage.getItem(KEYS.google) ?? "",
	};
}

export async function saveCredentials(
	creds: Partial<{
		anthropicKey: string;
		openaiKey: string;
		elevenLabsKey: string;
		googleKey: string;
	}>,
): Promise<void> {
	if (creds.anthropicKey !== undefined) {
		creds.anthropicKey
			? localStorage.setItem(KEYS.anthropic, creds.anthropicKey)
			: localStorage.removeItem(KEYS.anthropic);
	}
	if (creds.openaiKey !== undefined) {
		creds.openaiKey
			? localStorage.setItem(KEYS.openai, creds.openaiKey)
			: localStorage.removeItem(KEYS.openai);
	}
	if (creds.elevenLabsKey !== undefined) {
		creds.elevenLabsKey
			? localStorage.setItem(KEYS.elevenlabs, creds.elevenLabsKey)
			: localStorage.removeItem(KEYS.elevenlabs);
	}
	if (creds.googleKey !== undefined) {
		creds.googleKey
			? localStorage.setItem(KEYS.google, creds.googleKey)
			: localStorage.removeItem(KEYS.google);
	}
}
