const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DEFAULT_TARGETS = ["release"];

function sleep(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // Busy wait — keeps this script synchronous for npm hooks.
  }
}

function killWindowsProcesses() {
  if (process.platform !== "win32") return;

  for (const name of [
    "InspireTech.exe",
    "electron.exe",
    "virtualcam_feeder.exe",
    "audio_feeder.exe",
    "app-builder.exe",
  ]) {
    try {
      execSync(`taskkill /F /IM ${name} /T`, { stdio: "ignore" });
    } catch {
      // Process was not running.
    }
  }
}

function removePath(target) {
  if (!fs.existsSync(target)) return true;

  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    return !fs.existsSync(target);
  } catch {
    return false;
  }
}

function renameStaleDist(target) {
  if (!fs.existsSync(target)) return true;

  const base = path.basename(target);
  const staleName = `${base}-stale-${Date.now()}`;
  const stalePath = path.join(path.dirname(target), staleName);
  try {
    fs.renameSync(target, stalePath);
    console.warn(`[clean-dist] Moved locked output to ${staleName}. Delete it manually later.`);
    return true;
  } catch {
    return false;
  }
}

function cleanTarget(relativePath) {
  const target = path.join(ROOT, relativePath);
  console.log(`[clean-dist] Removing ${relativePath}...`);

  if (removePath(target)) {
    console.log(`[clean-dist] ${relativePath} cleared.`);
    return true;
  }

  console.warn(`[clean-dist] ${relativePath} is locked. Trying rename fallback...`);
  if (renameStaleDist(target)) {
    return true;
  }

  console.error(
    `[clean-dist] Could not clear ${relativePath}.\n` +
      "  Close InspireTech.exe if it is running, then run:\n" +
      "    npm run clean\n" +
      "  Or delete this folder manually:\n" +
      `    ${target}`
  );
  return false;
}

function main() {
  const targets = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_TARGETS;

  console.log("[clean-dist] Stopping InspireTech/Electron/feeder processes...");
  killWindowsProcesses();
  sleep(1500);

  for (const target of targets) {
    if (!cleanTarget(target)) {
      process.exit(1);
    }
  }

  console.log("[clean-dist] Ready for a fresh build.");
}

main();
