import { beforeEach, describe, expect, it, vi } from "vitest";
import { synthesiseTextElevenLabs } from "../elevenlabs";
import type { ChunkCache } from "../tts";

// Make sleep a no-op so retry tests don't wait 2s + 4s in real time
vi.mock("../text", async (importOriginal) => {
	const mod = await importOriginal<typeof import("../text")>();
	return { ...mod, sleep: vi.fn().mockResolvedValue(undefined) };
});

const voiceId = "21m00Tcm4TlvDq8ikWAM";
const format = "mp3" as const;
const model = "eleven_v3" as const;

function mockFetchOk(buf: Buffer) {
	return vi.fn().mockResolvedValue({
		ok: true,
		arrayBuffer: () =>
			Promise.resolve(
				buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
			),
	});
}

describe("synthesiseTextElevenLabs", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.unstubAllGlobals();
	});

	it("returns audio for a short text", async () => {
		const buf = Buffer.from("audio data");
		const fetchMock = mockFetchOk(buf);
		vi.stubGlobal("fetch", fetchMock);

		const result = await synthesiseTextElevenLabs(
			"key",
			"Hello world.",
			voiceId,
			format,
			model,
			1,
			(i) => `chunk-${i}`,
			null,
		);
		expect(result.length).toBeGreaterThan(0);
		expect(fetchMock).toHaveBeenCalledOnce();
		const [url, init] = fetchMock.mock.calls[0]!;
		expect(url).toContain(`/text-to-speech/${voiceId}`);
		expect(init.headers["xi-api-key"]).toBe("key");
		expect(JSON.parse(init.body)).toEqual({
			text: "Hello world.",
			model_id: model,
		});
	});

	it("reads from cache and skips the API call", async () => {
		const cached = Buffer.from("cached audio");
		const cache: ChunkCache = {
			get: vi.fn().mockResolvedValue(cached),
			set: vi.fn(),
		};
		const fetchMock = mockFetchOk(Buffer.from("should not be called"));
		vi.stubGlobal("fetch", fetchMock);

		const result = await synthesiseTextElevenLabs(
			"key",
			"Hello.",
			voiceId,
			format,
			model,
			1,
			(i) => `key-${i}`,
			cache,
		);
		expect(result).toEqual(cached);
		expect(cache.get).toHaveBeenCalledOnce();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("writes to cache after a successful API call", async () => {
		const audio = Buffer.from("fresh audio");
		const cache: ChunkCache = {
			get: vi.fn().mockResolvedValue(null),
			set: vi.fn(),
		};
		vi.stubGlobal("fetch", mockFetchOk(audio));

		await synthesiseTextElevenLabs(
			"key",
			"Hello.",
			voiceId,
			format,
			model,
			1,
			(i) => `key-${i}`,
			cache,
		);
		expect(cache.set).toHaveBeenCalledOnce();
	});

	it("retries up to 3 times on failure then throws", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: false,
			status: 500,
			statusText: "Internal Server Error",
			text: () => Promise.resolve("boom"),
		});
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			synthesiseTextElevenLabs(
				"key",
				"hello",
				voiceId,
				format,
				model,
				1,
				(i) => `k${i}`,
				null,
			),
		).rejects.toThrow("ElevenLabs TTS request failed (500): boom");
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("concatenates multiple chunks", async () => {
		const longText = "Word ".repeat(900).trim(); // ~4500 chars, > 2500 chunk limit
		const chunkBuf = Buffer.from([1, 2, 3]);
		const fetchMock = mockFetchOk(chunkBuf);
		vi.stubGlobal("fetch", fetchMock);

		const result = await synthesiseTextElevenLabs(
			"key",
			longText,
			voiceId,
			format,
			model,
			2,
			(i) => `c${i}`,
			null,
		);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(result.length).toBe(6);
	});

	it("invokes onChunk callback", async () => {
		const onChunk = vi.fn();
		vi.stubGlobal("fetch", mockFetchOk(Buffer.from("x")));

		await synthesiseTextElevenLabs(
			"key",
			"Short.",
			voiceId,
			format,
			model,
			1,
			(i) => `k${i}`,
			null,
			onChunk,
		);
		expect(onChunk).toHaveBeenCalledWith(0, 1, false);
	});

	it("requests opus output format when format is opus", async () => {
		const fetchMock = mockFetchOk(Buffer.from("x"));
		vi.stubGlobal("fetch", fetchMock);

		await synthesiseTextElevenLabs(
			"key",
			"Hi.",
			voiceId,
			"opus",
			model,
			1,
			(i) => `k${i}`,
			null,
		);
		const [url] = fetchMock.mock.calls[0]!;
		expect(url).toContain("output_format=opus_48000_128");
	});
});
