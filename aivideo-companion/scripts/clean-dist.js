const { execSync, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DIST = path.join(ROOT, "release");

function sleep(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // Busy wait — keeps this script synchronous for npm hooks.
  }
}

function killWindowsProcesses() {
  if (process.platform !== "win32") return;

  for (const name of ["InspireTech.exe", "electron.exe", "virtualcam_feeder.exe"]) {
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
  } catch (error) {
    return false;
  }
}

function renameStaleDist() {
  if (!fs.existsSync(DIST)) return true;

  const staleName = `release-stale-${Date.now()}`;
  const stalePath = path.join(ROOT, staleName);
  try {
    fs.renameSync(DIST, stalePath);
    console.warn(`[clean-dist] Moved locked output to ${staleName}. Delete it manually later.`);
    return true;
  } catch {
    return false;
  }
}

function main() {
  console.log("[clean-dist] Stopping InspireTech/Electron/feeder processes...");
  killWindowsProcesses();
  sleep(1500);

  console.log("[clean-dist] Removing release output...");
  if (removePath(DIST)) {
    console.log("[clean-dist] Ready for a fresh build.");
    return;
  }

  console.warn("[clean-dist] release is locked. Trying rename fallback...");
  if (renameStaleDist()) {
    console.log("[clean-dist] Output folder cleared via rename.");
    return;
  }

  console.error(
    "[clean-dist] Could not clear release output.\n" +
      "  Close InspireTech.exe if it is running, then run:\n" +
      "    npm run clean\n" +
      "  Or delete this folder manually:\n" +
      `    ${DIST}`
  );
  process.exit(1);
}

main();
