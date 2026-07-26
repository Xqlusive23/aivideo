const fs = require("fs");
const path = require("path");

const FILTER_CPP = path.join(
  __dirname,
  "..",
  "resources",
  "drivers",
  "unity-capture-src",
  "Source",
  "UnityCaptureFilter.cpp"
);

const PORTRAIT_MEDIA = `\t{  720, 1280 }, //9:16 portrait
\t{ 1080, 1920 }, //9:16 portrait HD`;

function patchUnityCapturePortrait() {
  if (!fs.existsSync(FILTER_CPP)) {
    console.log("[patch-unity-capture] Source not found — clone Unity Capture first.");
    return false;
  }

  let source = fs.readFileSync(FILTER_CPP, "utf8");
  if (source.includes("{  720, 1280 }, //9:16 portrait")) {
    console.log("[patch-unity-capture] Portrait resolutions already patched.");
    return true;
  }

  const marker = "\t{ 1280,  720 }, //16:9";
  if (!source.includes(marker)) {
    console.warn("[patch-unity-capture] Could not find media list marker — skip patch.");
    return false;
  }

  source = source.replace(marker, `${PORTRAIT_MEDIA}\n${marker}`);
  fs.writeFileSync(FILTER_CPP, source, "utf8");
  console.log("[patch-unity-capture] Added 720×1280 and 1080×1920 to Unity Capture media list.");
  console.log("[patch-unity-capture] Rebuild UnityCaptureFilter64.dll with Visual Studio to ship the driver update.");
  return true;
}

if (require.main === module) {
  patchUnityCapturePortrait();
}

module.exports = { patchUnityCapturePortrait };
