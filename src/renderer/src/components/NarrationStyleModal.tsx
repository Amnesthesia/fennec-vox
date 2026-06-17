interface Suggestion {
	instructions: string;
	recognized: boolean;
	bookTitle: string;
	bookAuthor: string;
}

interface Props {
	suggestion: Suggestion;
	onAccept: () => void;
	onDecline: () => void;
}

export default function NarrationStyleModal({
	suggestion,
	onAccept,
	onDecline,
}: Props) {
	return (
		<div
			className="modal-overlay"
			onClick={(e) => e.target === e.currentTarget && onDecline()}
		>
			<div
				className="modal"
				role="dialog"
				aria-modal="true"
				aria-label="Suggested narration style"
			>
				<div className="modal-inner">
					<h2>Suggested narration style</h2>
					<p className="modal-sub">
						{suggestion.recognized
							? `Fennec Vox recognized "${suggestion.bookTitle}" by ${suggestion.bookAuthor} and suggests a narration style tailored to it.`
							: `Based on the opening pages of "${suggestion.bookTitle}", Fennec Vox suggests this narration style.`}
					</p>
					<div className="narration-suggestion-box">
						{suggestion.instructions}
					</div>
					<div className="modal-footer">
						<button
							className="btn btn-secondary"
							onClick={onDecline}
							type="button"
						>
							Keep current
						</button>
						<button
							className="btn btn-primary"
							onClick={onAccept}
							type="button"
						>
							Use this style
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}
