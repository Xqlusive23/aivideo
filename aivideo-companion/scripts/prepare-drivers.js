const fs = require("fs");
const path = require("path");
const { buildUnityCapturePortrait } = require("./build-unity-capture");

const ROOT = path.join(__dirname, "..");
const DRIVERS = path.join(ROOT, "resources", "drivers");

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

buildUnityCapturePortrait();
checkVbCable();
