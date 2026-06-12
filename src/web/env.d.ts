/// <reference types="vite/client" />
import type { BrowserAPI } from "./api";

declare global {
	interface Window {
		api: BrowserAPI;
	}
}
