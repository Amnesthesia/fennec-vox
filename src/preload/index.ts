import type {
	ConversionOptions,
	ProgressEvent,
	TtsModel,
	TtsVoice,
} from "@shared/ipc";
import { IPC } from "@shared/ipc";
import { contextBridge, ipcRenderer } from "electron";

const api = {
	// File pickers
	selectEpub: (): Promise<string | null> => ipcRenderer.invoke(IPC.SELECT_EPUB),
	selectOutputDir: (): Promise<string | null> =>
		ipcRenderer.invoke(IPC.SELECT_OUTPUT_DIR),

	// Credentials
	getCredentials: (): Promise<{ anthropicKey: string; openaiKey: string }> =>
		ipcRenderer.invoke(IPC.GET_CREDENTIALS),
	saveCredentials: (c: {
		anthropicKey: string;
		openaiKey: string;
	}): Promise<void> => ipcRenderer.invoke(IPC.SAVE_CREDENTIALS, c),

	// Open a URL in the system browser
	openExternal: (url: string): Promise<void> =>
		ipcRenderer.invoke(IPC.OPEN_EXTERNAL, url),

	// Voice preview
	previewVoice: (opts: {
		voice: TtsVoice;
		model: TtsModel;
		instructions?: string;
	}): Promise<{ audio?: string; error?: string }> =>
		ipcRenderer.invoke(IPC.PREVIEW_VOICE, opts),

	// Conversion
	startConversion: (
		opts: ConversionOptions,
	): Promise<{ ok?: boolean; error?: string }> =>
		ipcRenderer.invoke(IPC.START_CONVERSION, opts),
	stopConversion: (): Promise<{ ok?: boolean; error?: string }> =>
		ipcRenderer.invoke(IPC.STOP_CONVERSION),

	// Event subscriptions (return unsubscribe function)
	onProgress: (cb: (event: ProgressEvent) => void): (() => void) => {
		const handler = (_: Electron.IpcRendererEvent, e: ProgressEvent) => cb(e);
		ipcRenderer.on(IPC.CONVERSION_PROGRESS, handler);
		return () => ipcRenderer.off(IPC.CONVERSION_PROGRESS, handler);
	},
	onLog: (cb: (line: string) => void): (() => void) => {
		const handler = (_: Electron.IpcRendererEvent, line: string) => cb(line);
		ipcRenderer.on(IPC.CONVERSION_LOG, handler);
		return () => ipcRenderer.off(IPC.CONVERSION_LOG, handler);
	},
	onComplete: (
		cb: (event: ProgressEvent & { type: "complete" }) => void,
	): (() => void) => {
		const handler = (_: Electron.IpcRendererEvent, e: ProgressEvent) =>
			cb(e as ProgressEvent & { type: "complete" });
		ipcRenderer.on(IPC.CONVERSION_COMPLETE, handler);
		return () => ipcRenderer.off(IPC.CONVERSION_COMPLETE, handler);
	},
	onError: (cb: (message: string) => void): (() => void) => {
		const handler = (_: Electron.IpcRendererEvent, msg: string) => cb(msg);
		ipcRenderer.on(IPC.CONVERSION_ERROR, handler);
		return () => ipcRenderer.off(IPC.CONVERSION_ERROR, handler);
	},
};

contextBridge.exposeInMainWorld("api", api);

export type ElectronAPI = typeof api;
