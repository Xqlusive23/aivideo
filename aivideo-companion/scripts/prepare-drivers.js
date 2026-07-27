const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { buildUnityCapturePortrait } = require("./build-unity-capture");

const ROOT = path.join(__dirname, "..");
const DRIVERS = path.join(ROOT, "resources", "drivers");
const VB_CABLE_ZIP_URL =
  "https://download.vb-audio.com/Download_CABLE/VBCABLE_Driver_Pack43.zip";

function hasVbCableInstaller(vbDir) {
  return ["VBCABLE_Setup_x64.exe", "VBCABLE_Setup.exe", "setup.exe"].some((name) =>
    fs.existsSync(path.join(vbDir, name))
  );
}

function hasVbCableInf(vbDir) {
  try {
    return fs.readdirSync(vbDir).some((name) => name.toLowerCase().endsWith(".inf"));
  } catch {
    return false;
  }
}

function isVbCableComplete(vbDir) {
  return hasVbCableInstaller(vbDir) && hasVbCableInf(vbDir);
}

function extractZipToDir(zipPath, destDir) {
  const ps = `
$ErrorActionPreference = 'Stop'
Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force
`.trim();
  execFileSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps],
    { stdio: "inherit" }
  );
}

function downloadVbCableZip(zipPath) {
  const ps = `
$ErrorActionPreference = 'Stop'
Invoke-WebRequest -Uri '${VB_CABLE_ZIP_URL}' -OutFile '${zipPath.replace(/'/g, "''")}' -UseBasicParsing
`.trim();
  execFileSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps],
    { stdio: "inherit" }
  );
}

function ensureVbCablePackage(vbDir) {
  if (isVbCableComplete(vbDir)) {
    return true;
  }

  const localZip = fs
    .readdirSync(vbDir)
    .find((name) => /^VBCABLE.*\.zip$/i.test(name));
  if (localZip) {
    console.log(`[prepare-drivers] Extracting local VB-CABLE zip: ${localZip}`);
    extractZipToDir(path.join(vbDir, localZip), vbDir);
    if (isVbCableComplete(vbDir)) {
      return true;
    }
  }

  const downloadedZip = path.join(vbDir, "VBCABLE_Driver_Pack43.zip");
  console.log("[prepare-drivers] Downloading full VB-CABLE driver package…");
  downloadVbCableZip(downloadedZip);
  extractZipToDir(downloadedZip, vbDir);
  try {
    fs.unlinkSync(downloadedZip);
  } catch {
    // ignore cleanup failures
  }

  return isVbCableComplete(vbDir);
}

function checkVbCable() {
  const vbDir = path.join(DRIVERS, "vb-cable");
  fs.mkdirSync(vbDir, { recursive: true });

  if (ensureVbCablePackage(vbDir)) {
    console.log("[prepare-drivers] VB-CABLE package ready (installer + .inf files).");
    return;
  }

  console.warn(
    "[prepare-drivers] VB-CABLE package is incomplete.\n" +
      "  Download the full ZIP from https://vb-audio.com/Cable/ and either:\n" +
      `  - extract all files into ${vbDir}\n` +
      "  - or place the ZIP there and re-run npm run prepare:drivers\n" +
      "  The setup wizard can still install InspireTech Camera without VB-CABLE."
  );
}

buildUnityCapturePortrait();
checkVbCable();
