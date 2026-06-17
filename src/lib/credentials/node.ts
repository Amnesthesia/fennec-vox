const SERVICE = "Fennec Vox";
const ACCOUNTS = {
	anthropic: "anthropic-api-key",
	openai: "openai-api-key",
	elevenlabs: "elevenlabs-api-key",
	google: "google-api-key",
} as const;

function getKeytar() {
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		return require("keytar") as typeof import("keytar");
	} catch {
		return null;
	}
}

export async function getCredentials(): Promise<{
	anthropicKey: string;
	openaiKey: string;
	elevenLabsKey: string;
	googleKey: string;
}> {
	const keytar = getKeytar();
	if (!keytar)
		return {
			anthropicKey: "",
			openaiKey: "",
			elevenLabsKey: "",
			googleKey: "",
		};
	const [anthropicKey, openaiKey, elevenLabsKey, googleKey] = await Promise.all(
		[
			keytar.getPassword(SERVICE, ACCOUNTS.anthropic),
			keytar.getPassword(SERVICE, ACCOUNTS.openai),
			keytar.getPassword(SERVICE, ACCOUNTS.elevenlabs),
			keytar.getPassword(SERVICE, ACCOUNTS.google),
		],
	);
	return {
		anthropicKey: anthropicKey ?? "",
		openaiKey: openaiKey ?? "",
		elevenLabsKey: elevenLabsKey ?? "",
		googleKey: googleKey ?? "",
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
	const keytar = getKeytar();
	if (!keytar) return;
	const ops: Promise<void>[] = [];
	if (creds.anthropicKey !== undefined) {
		ops.push(
			creds.anthropicKey
				? keytar.setPassword(SERVICE, ACCOUNTS.anthropic, creds.anthropicKey)
				: keytar
						.deletePassword(SERVICE, ACCOUNTS.anthropic)
						.then(() => undefined),
		);
	}
	if (creds.openaiKey !== undefined) {
		ops.push(
			creds.openaiKey
				? keytar.setPassword(SERVICE, ACCOUNTS.openai, creds.openaiKey)
				: keytar.deletePassword(SERVICE, ACCOUNTS.openai).then(() => undefined),
		);
	}
	if (creds.elevenLabsKey !== undefined) {
		ops.push(
			creds.elevenLabsKey
				? keytar.setPassword(SERVICE, ACCOUNTS.elevenlabs, creds.elevenLabsKey)
				: keytar
						.deletePassword(SERVICE, ACCOUNTS.elevenlabs)
						.then(() => undefined),
		);
	}
	if (creds.googleKey !== undefined) {
		ops.push(
			creds.googleKey
				? keytar.setPassword(SERVICE, ACCOUNTS.google, creds.googleKey)
				: keytar.deletePassword(SERVICE, ACCOUNTS.google).then(() => undefined),
		);
	}
	await Promise.all(ops);
}
