// main.js — Electron main process for the InspireTech desktop app.
//
// Production build opens the live studio at inspirestream.xyz (see paths.js).
// Dev mode (INSPIRETECH_DEV=1) loads http://localhost:5173 instead.
//
// On first authenticated launch, the web app installs virtual camera (Unity
// Capture) and virtual audio (VB-CABLE) drivers via the preload bridge.

const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("fs");
const path = require("path");
const {
  registerSetupIpc,
} = require("./setup");
const { getAppUrl } = require("./paths");
const { startFeeder, sendFrameToFeeder, stopFeeder } = require("./feeder");
const {
  startAudioFeeder,
  sendAudioToFeeder,
  stopAudioFeeder,
} = require("./audio-feeder");

let mainWindow;

function getWindowIcon() {
  const iconPath = path.join(__dirname, "build", "icon.png");
  return fs.existsSync(iconPath) ? iconPath : undefined;
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    title: "InspireTech",
    icon: getWindowIcon(),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadURL(getAppUrl());

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

ipcMain.on("inspiretech:frame", (_event, arrayBuffer) => {
  sendFrameToFeeder(Buffer.from(arrayBuffer));
});

ipcMain.on("inspiretech:audio-start", (_event, sampleRate) => {
  startAudioFeeder(Number(sampleRate) || 48000);
});

ipcMain.on("inspiretech:audio-chunk", (_event, arrayBuffer) => {
  sendAudioToFeeder(Buffer.from(arrayBuffer));
});

ipcMain.on("inspiretech:audio-stop", () => {
  stopAudioFeeder();
});

async function launchApp() {
  registerSetupIpc();
  startFeeder();
  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
}

app.whenReady().then(launchApp);

app.on("window-all-closed", () => {
  stopAudioFeeder();
  stopFeeder();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  stopAudioFeeder();
  stopFeeder();
});
