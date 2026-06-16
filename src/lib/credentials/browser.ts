const KEYS = {
	anthropic: "fennec-vox:anthropic-key",
	openai: "fennec-vox:openai-key",
} as const;

export async function getCredentials(): Promise<{
	anthropicKey: string;
	openaiKey: string;
}> {
	return {
		anthropicKey: localStorage.getItem(KEYS.anthropic) ?? "",
		openaiKey: localStorage.getItem(KEYS.openai) ?? "",
	};
}

export async function saveCredentials(
	creds: Partial<{ anthropicKey: string; openaiKey: string }>,
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
}
