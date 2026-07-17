const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const DRIVERS = path.join(ROOT, "resources", "drivers");
const UNITY_SRC = path.join(DRIVERS, "unity-capture-src", "Install");
const UNITY_DEST = path.join(DRIVERS, "unity-capture");
const REPO_URL = "https://github.com/schellingb/UnityCapture.git";

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(from, to);
    } else {
      fs.copyFileSync(from, to);
    }
  }
}

function ensureUnityCapture() {
  const dllPath = path.join(UNITY_DEST, "UnityCaptureFilter64.dll");
  if (fs.existsSync(dllPath)) {
    console.log("[prepare-drivers] Unity Capture already prepared.");
    return;
  }

  if (!fs.existsSync(path.join(UNITY_SRC, "UnityCaptureFilter64.dll"))) {
    console.log("[prepare-drivers] Cloning Unity Capture...");
    fs.mkdirSync(DRIVERS, { recursive: true });
    execSync(`git clone --depth 1 ${REPO_URL} "${path.join(DRIVERS, "unity-capture-src")}"`, {
      stdio: "inherit",
    });
  }

  console.log("[prepare-drivers] Copying Unity Capture install files...");
  copyDir(UNITY_SRC, UNITY_DEST);

  const templateInstaller = path.join(ROOT, "scripts", "templates", "InstallInspireTech.bat");
  fs.copyFileSync(templateInstaller, path.join(UNITY_DEST, "InstallInspireTech.bat"));

  console.log("[prepare-drivers] Unity Capture ready at resources/drivers/unity-capture/");
}

function refreshUnityCaptureInstaller() {
  const dllPath = path.join(UNITY_DEST, "UnityCaptureFilter64.dll");
  const templateInstaller = path.join(ROOT, "scripts", "templates", "InstallInspireTech.bat");
  if (fs.existsSync(dllPath) && fs.existsSync(templateInstaller)) {
    fs.copyFileSync(templateInstaller, path.join(UNITY_DEST, "InstallInspireTech.bat"));
    console.log("[prepare-drivers] Refreshed InstallInspireTech.bat");
  }
}

function checkVbCable() {
  const vbDir = path.join(DRIVERS, "vb-cable");
  fs.mkdirSync(vbDir, { recursive: true });

  const candidates = ["VBCABLE_Setup_x64.exe", "VBCABLE_Setup.exe", "setup.exe"];
  const found = candidates.find((name) => fs.existsSync(path.join(vbDir, name)));

  if (found) {
    console.log(`[prepare-drivers] VB-CABLE installer found: ${found}`);
    return;
  }

  console.warn(
    "[prepare-drivers] VB-CABLE installer not found.\n" +
      "  Download from https://vb-audio.com/Cable/ and place VBCABLE_Setup_x64.exe in:\n" +
      `  ${vbDir}\n` +
      "  The desktop app setup wizard will still install the virtual camera, but audio\n" +
      "  driver install will be skipped until the installer is bundled."
  );
}

ensureUnityCapture();
refreshUnityCaptureInstaller();
checkVbCable();
