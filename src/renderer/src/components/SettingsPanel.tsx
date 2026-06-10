import { useEffect, useState } from "react";

interface Props {
	onClose: () => void;
}

export default function SettingsPanel({ onClose }: Props) {
	const [anthropicKey, setAnthropicKey] = useState("");
	const [openaiKey, setOpenaiKey] = useState("");
	const [saving, setSaving] = useState(false);
	const [saved, setSaved] = useState(false);

	useEffect(() => {
		void window.api.getCredentials().then((creds) => {
			setAnthropicKey(creds.anthropicKey);
			setOpenaiKey(creds.openaiKey);
		});
	}, []);

	const handleSave = async () => {
		setSaving(true);
		await window.api.saveCredentials({ anthropicKey, openaiKey });
		setSaving(false);
		setSaved(true);
		setTimeout(() => setSaved(false), 2000);
	};

	const maskKey = (key: string) =>
		key.length > 8
			? `${key.slice(0, 4)}${"•".repeat(Math.min(16, key.length - 8))}${key.slice(-4)}`
			: key;

	const activeProvider = anthropicKey
		? "Claude Haiku (ANTHROPIC_API_KEY set)"
		: openaiKey
			? "GPT-4o mini (fallback)"
			: "None — add an OpenAI key to continue";

	return (
		<div
			className="modal-overlay"
			onClick={(e) => e.target === e.currentTarget && onClose()}
		>
			<div
				className="modal"
				role="dialog"
				aria-modal="true"
				aria-label="Settings"
			>
				<div className="modal-inner">
					<h2>Settings</h2>
					<p className="modal-sub">
						API keys are stored securely in the Mac system keychain. Claude
						Haiku is used for SSML markup when an Anthropic key is present;
						otherwise GPT-4o mini is used.
					</p>

					{/* OpenAI */}
					<div className="settings-key-label">
						<span className="section-label" style={{ marginBottom: 0 }}>
							OpenAI (TTS + fallback markup)
						</span>
						<button
							className="settings-get-key-link"
							type="button"
							onClick={() =>
								void window.api.openExternal(
									"https://platform.openai.com/api-keys",
								)
							}
						>
							Get key →
						</button>
					</div>
					<div className="key-row" style={{ marginTop: 6 }}>
						<div className="field">
							<input
								type="password"
								value={openaiKey}
								placeholder="sk-…"
								onChange={(e) => setOpenaiKey(e.target.value)}
								autoComplete="off"
								spellCheck={false}
							/>
						</div>
						{openaiKey && (
							<button
								className="btn btn-secondary"
								style={{ fontSize: 11, padding: "5px 8px" }}
								onClick={() => setOpenaiKey("")}
								type="button"
								title="Clear key"
							>
								✕
							</button>
						)}
					</div>
					{openaiKey && (
						<div
							style={{
								fontSize: 10,
								color: "var(--text-secondary)",
								marginBottom: 12,
							}}
						>
							Stored: {maskKey(openaiKey)}
						</div>
					)}

					{/* Anthropic */}
					<div className="settings-key-label" style={{ marginTop: 8 }}>
						<span className="section-label" style={{ marginBottom: 0 }}>
							Anthropic (Claude Haiku — optional)
						</span>
						<button
							className="settings-get-key-link"
							type="button"
							onClick={() =>
								void window.api.openExternal(
									"https://console.anthropic.com/settings/keys",
								)
							}
						>
							Get key →
						</button>
					</div>
					<div className="key-row" style={{ marginTop: 6 }}>
						<div className="field">
							<input
								type="password"
								value={anthropicKey}
								placeholder="sk-ant-…"
								onChange={(e) => setAnthropicKey(e.target.value)}
								autoComplete="off"
								spellCheck={false}
							/>
						</div>
						{anthropicKey && (
							<button
								className="btn btn-secondary"
								style={{ fontSize: 11, padding: "5px 8px" }}
								onClick={() => setAnthropicKey("")}
								type="button"
								title="Clear key"
							>
								✕
							</button>
						)}
					</div>
					{anthropicKey && (
						<div
							style={{
								fontSize: 10,
								color: "var(--text-secondary)",
								marginBottom: 12,
							}}
						>
							Stored: {maskKey(anthropicKey)}
						</div>
					)}

					<div className="provider-status">
						<div
							className="dot"
							style={{
								background: openaiKey ? "var(--success)" : "var(--warning)",
							}}
						/>
						<span>
							Active markup provider: <strong>{activeProvider}</strong>
						</span>
					</div>

					<div className="modal-footer">
						<button
							className="btn btn-secondary"
							onClick={onClose}
							type="button"
						>
							Cancel
						</button>
						<button
							className="btn btn-primary"
							onClick={() => void handleSave()}
							disabled={saving || !openaiKey}
							type="button"
						>
							{saved ? "✓ Saved" : saving ? "Saving…" : "Save"}
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}
