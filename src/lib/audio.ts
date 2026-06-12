import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { Buffer } from "buffer";
import fs from "fs-extra";

const execFileAsync = promisify(execFile);

export function resolveFfmpegBin(): string {
	const rp = (process as typeof process & { resourcesPath?: string })
		.resourcesPath;
	if (rp) {
		const candidate = path.join(
			rp,
			process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg",
		);
		if (fs.existsSync(candidate)) return candidate;
	}
	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const p = (require as (id: string) => string | null)("ffmpeg-static");
		if (p && fs.existsSync(p)) return p;
	} catch {
		/* not installed */
	}
	return "ffmpeg";
}

export function getAudioDurationMs(
	ffmpegBin: string,
	filePath: string,
): Promise<number> {
	return new Promise((resolve, reject) => {
		const proc = spawn(ffmpegBin, ["-i", filePath, "-f", "null", "-"], {
			stdio: ["ignore", "ignore", "pipe"],
		});
		let stderr = "";
		proc.stderr?.on("data", (d: Buffer) => {
			stderr += d.toString();
		});
		proc.on("close", () => {
			const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
			if (!m)
				return reject(new Error(`Could not parse duration for ${filePath}`));
			const ms =
				(parseInt(m[1]!, 10) * 3600 +
					parseInt(m[2]!, 10) * 60 +
					parseInt(m[3]!, 10)) *
					1000 +
				Math.round(parseInt(m[4]!, 10) * (1000 / 10 ** m[4]?.length));
			resolve(ms);
		});
	});
}

export async function buildM4b(
	chapters: { file: string; title: string }[],
	outputFile: string,
	bookTitle: string,
	bookAuthor: string,
	ffmpegBin: string,
): Promise<Buffer> {
	const tmpDir = path.dirname(outputFile);

	const durations: number[] = [];
	for (const ch of chapters) {
		durations.push(await getAudioDurationMs(ffmpegBin, ch.file));
	}

	let meta = ";FFMETADATA1\n";
	meta += `title=${bookTitle}\n`;
	meta += `artist=${bookAuthor}\n\n`;
	let cursor = 0;
	for (let i = 0; i < chapters.length; i++) {
		const start = cursor;
		const end = cursor + durations[i]!;
		meta += `[CHAPTER]\nTIMEBASE=1/1000\nSTART=${start}\nEND=${end}\ntitle=${chapters[i]?.title}\n\n`;
		cursor = end;
	}

	const metaFile = path.join(tmpDir, "_ffmeta.txt");
	const concatFile = path.join(tmpDir, "_concat.txt");
	await fs.writeFile(metaFile, meta, "utf8");
	await fs.writeFile(
		concatFile,
		chapters
			.map(
				(ch) => `file '${ch.file.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`,
			)
			.join("\n"),
		"utf8",
	);

	await execFileAsync(ffmpegBin, [
		"-f",
		"concat",
		"-safe",
		"0",
		"-i",
		concatFile,
		"-i",
		metaFile,
		"-map_metadata",
		"1",
		"-map",
		"0:a",
		"-c:a",
		"copy",
		"-movflags",
		"+faststart",
		"-y",
		outputFile,
	]);

	await fs.remove(metaFile);
	await fs.remove(concatFile);

	return fs.readFile(outputFile);
}
