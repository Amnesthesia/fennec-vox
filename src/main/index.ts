import path from "node:path";
import { app, BrowserWindow, Menu } from "electron";
import { registerIpcHandlers } from "./ipc";

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
	app.quit();
}

let mainWindow: BrowserWindow | null = null;

function createWindow(): BrowserWindow {
	const win = new BrowserWindow({
		width: 900,
		height: 660,
		minWidth: 760,
		minHeight: 560,
		title: "Fennec Vox",
		titleBarStyle: "hiddenInset",
		backgroundColor: "#f9f9f9",
		webPreferences: {
			preload: path.join(__dirname, "../preload/index.js"),
			contextIsolation: true,
			nodeIntegration: false,
		},
	});

	if (process.env.NODE_ENV === "development") {
		void win.loadURL(
			process.env.ELECTRON_RENDERER_URL ?? "http://localhost:5173",
		);
		win.webContents.openDevTools({ mode: "detach" });
	} else {
		void win.loadFile(path.join(__dirname, "../renderer/index.html"));
	}

	win.on("closed", () => {
		mainWindow = null;
	});

	return win;
}

function buildMenu(): void {
	const template: Electron.MenuItemConstructorOptions[] = [
		{
			label: "Fennec Vox",
			submenu: [
				{ role: "about" },
				{ type: "separator" },
				{ role: "hide" },
				{ role: "hideOthers" },
				{ role: "unhide" },
				{ type: "separator" },
				{ role: "quit" },
			],
		},
		{
			label: "Edit",
			submenu: [
				{ role: "undo" },
				{ role: "redo" },
				{ type: "separator" },
				{ role: "cut" },
				{ role: "copy" },
				{ role: "paste" },
				{ role: "selectAll" },
			],
		},
		{
			label: "Window",
			submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "front" }],
		},
	];
	Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
	mainWindow = createWindow();
	registerIpcHandlers(mainWindow);
	buildMenu();

	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
	});
});

app.on("second-instance", () => {
	if (mainWindow && !mainWindow.isDestroyed()) {
		if (mainWindow.isMinimized()) mainWindow.restore();
		mainWindow.focus();
	}
});

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") app.quit();
});
