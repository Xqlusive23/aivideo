const { app, ipcMain, shell } = require("electron");
const { autoUpdater } = require("electron-updater");
const fs = require("fs");
const https = require("https");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");

const CHANNEL = "inspiretech:update";
const GITHUB_RELEASES_URL =
  "https://api.github.com/repos/Xqlusive23/aivideo/releases/latest";

let mainWindowRef = null;
let pendingUpdate = null;
let updateMode = "auto"; // "auto" = electron-updater, "manual" = downloaded GitHub asset

function sendEvent(event, payload = {}) {
  if (!mainWindowRef || mainWindowRef.isDestroyed()) return;
  mainWindowRef.webContents.send(`${CHANNEL}:event`, { event, ...payload });
}

function parseVersionParts(value) {
  return String(value || "")
    .replace(/^v/i, "")
    .split(".")
    .map((part) => parseInt(part, 10) || 0);
}

function isVersionNewer(candidate, current) {
  const next = parseVersionParts(candidate);
  const now = parseVersionParts(current);
  for (let i = 0; i < Math.max(next.length, now.length); i += 1) {
    const diff = (next[i] || 0) - (now[i] || 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

function pickWindowsAsset(assets = []) {
  return (
    assets.find((asset) => /\.exe$/i.test(asset.name) && /setup/i.test(asset.name)) ||
    assets.find((asset) => /\.exe$/i.test(asset.name)) ||
    null
  );
}

async function fetchLatestGitHubRelease() {
  const response = await fetch(GITHUB_RELEASES_URL, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "InspireTech-Desktop",
    },
  });
  if (!response.ok) {
    throw new Error(`Could not reach GitHub releases (${response.status})`);
  }
  return response.json();
}

async function checkGitHubFallback() {
  const release = await fetchLatestGitHubRelease();
  const latestVersion = String(release.tag_name || "").replace(/^v/i, "");
  const currentVersion = app.getVersion();
  if (!latestVersion || !isVersionNewer(latestVersion, currentVersion)) {
    return null;
  }

  const asset = pickWindowsAsset(release.assets);
  if (!asset?.browser_download_url) {
    throw new Error("Latest release has no Windows installer attached.");
  }

  return {
    version: latestVersion,
    releaseNotes: release.body || "",
    releaseDate: release.published_at || "",
    downloadUrl: asset.browser_download_url,
    releasePageUrl: release.html_url,
  };
}

function downloadFile(url, destination, onProgress) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https:") ? https : http;

    const request = client.get(url, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        downloadFile(response.headers.location, destination, onProgress).then(resolve).catch(reject);
        return;
      }
      if (response.statusCode !== 200) {
        reject(new Error(`Download failed (${response.statusCode})`));
        return;
      }

      const total = Number(response.headers["content-length"] || 0);
      let transferred = 0;
      const file = fs.createWriteStream(destination);

      response.on("data", (chunk) => {
        transferred += chunk.length;
        if (total > 0) {
          onProgress({
            percent: (transferred / total) * 100,
            transferred,
            total,
          });
        }
      });

      response.pipe(file);
      file.on("finish", () => file.close(() => resolve(destination)));
      file.on("error", reject);
    });

    request.on("error", reject);
  });
}

async function downloadAndLaunchInstaller(info) {
  const safeVersion = String(info.version || "latest").replace(/[^\d.]/g, "") || "latest";
  const destination = path.join(app.getPath("temp"), `InspireTech-Setup-${safeVersion}.exe`);
  sendEvent("progress", { percent: 0, transferred: 0, total: 0, mode: "manual" });

  await downloadFile(info.downloadUrl, destination, (progress) => {
    sendEvent("progress", { ...progress, mode: "manual" });
  });

  spawn(destination, [], { detached: true, stdio: "ignore" }).unref();
  sendEvent("downloaded", { version: info.version, mode: "manual" });
  setTimeout(() => app.quit(), 750);
}

function registerAutoUpdaterEvents() {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on("checking-for-update", () => sendEvent("checking"));
  autoUpdater.on("update-available", (info) => {
    updateMode = "auto";
    pendingUpdate = info;
    sendEvent("available", {
      version: info.version,
      currentVersion: app.getVersion(),
      releaseNotes: info.releaseNotes,
      releaseDate: info.releaseDate,
      mode: "auto",
    });
  });
  autoUpdater.on("update-not-available", (info) => {
    sendEvent("not-available", { version: info?.version || app.getVersion() });
  });
  autoUpdater.on("error", (error) => {
    sendEvent("error", { message: String(error?.message || error), mode: updateMode });
  });
  autoUpdater.on("download-progress", (progress) => {
    sendEvent("progress", {
      percent: progress.percent,
      transferred: progress.transferred,
      total: progress.total,
      mode: "auto",
    });
  });
  autoUpdater.on("update-downloaded", (info) => {
    sendEvent("downloaded", {
      version: info.version,
      currentVersion: app.getVersion(),
      mode: "auto",
    });
  });
}

async function runUpdateCheck() {
  if (!app.isPackaged) {
    sendEvent("not-available", { version: app.getVersion(), dev: true });
    return { ok: true, source: "dev" };
  }

  sendEvent("checking");

  try {
    await autoUpdater.checkForUpdates();
    return { ok: true, source: "auto" };
  } catch (error) {
    try {
      const fallback = await checkGitHubFallback();
      if (!fallback) {
        sendEvent("not-available", { version: app.getVersion() });
        return { ok: true, source: "fallback-none" };
      }

      updateMode = "manual";
      pendingUpdate = fallback;
      sendEvent("available", {
        version: fallback.version,
        currentVersion: app.getVersion(),
        releaseNotes: fallback.releaseNotes,
        releaseDate: fallback.releaseDate,
        downloadUrl: fallback.downloadUrl,
        releasePageUrl: fallback.releasePageUrl,
        mode: "manual",
        fallbackReason: String(error?.message || error),
      });
      return { ok: true, source: "fallback" };
    } catch (fallbackError) {
      sendEvent("error", {
        message: String(fallbackError?.message || fallbackError),
      });
      return { ok: false, error: String(fallbackError?.message || fallbackError) };
    }
  }
}

function registerUpdaterIpc() {
  ipcMain.handle(`${CHANNEL}:version`, () => app.getVersion());

  ipcMain.handle(`${CHANNEL}:check`, async () => {
    try {
      return await runUpdateCheck();
    } catch (error) {
      return { ok: false, error: String(error?.message || error) };
    }
  });

  ipcMain.handle(`${CHANNEL}:download`, async () => {
    if (!pendingUpdate) {
      throw new Error("No update is ready to download.");
    }

    if (updateMode === "manual") {
      await downloadAndLaunchInstaller(pendingUpdate);
      return { ok: true, mode: "manual" };
    }

    await autoUpdater.downloadUpdate();
    return { ok: true, mode: "auto" };
  });

  ipcMain.handle(`${CHANNEL}:install`, () => {
    if (updateMode !== "auto") {
      throw new Error("In-app restart install is only available for auto-updates.");
    }
    autoUpdater.quitAndInstall(false, true);
  });

  ipcMain.handle(`${CHANNEL}:open-release-page`, async () => {
    const url =
      pendingUpdate?.releasePageUrl ||
      "https://github.com/Xqlusive23/aivideo/releases/latest";
    await shell.openExternal(url);
  });
}

function setUpdateMainWindow(window) {
  mainWindowRef = window;
}

function scheduleUpdateCheck(delayMs = 8000) {
  if (!app.isPackaged) return;
  setTimeout(() => {
    runUpdateCheck().catch(() => {});
  }, delayMs);
}

function initUpdater() {
  if (!app.isPackaged) return;
  registerAutoUpdaterEvents();
}

module.exports = {
  initUpdater,
  registerUpdaterIpc,
  setUpdateMainWindow,
  scheduleUpdateCheck,
  runUpdateCheck,
};
