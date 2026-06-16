import React from "react";
import { createRoot } from "react-dom/client";
import App from "../renderer/src/App";
import { browserApi } from "./api";
import "../renderer/src/app.css";

// Polyfill window.api so the shared React components use the browser implementation.
(window as unknown as { api: typeof browserApi }).api = browserApi;

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");
createRoot(root).render(
	<React.StrictMode>
		<App />
	</React.StrictMode>,
);
