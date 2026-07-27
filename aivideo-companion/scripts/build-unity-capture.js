const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const DRIVERS = path.join(ROOT, "resources", "drivers");
const FILTER_DIR = path.join(DRIVERS, "unity-capture-src", "Source");
const PROJ = path.join(FILTER_DIR, "UnityCaptureFilter.vcxproj");
const UNITY_DEST = path.join(DRIVERS, "unity-capture-bundle");
const UNITY_SRC_INSTALL = path.join(DRIVERS, "unity-capture-src", "Install");
const REPO_URL = "https://github.com/schellingb/UnityCapture.git";

function findVcVars() {
  const candidates = [
    process.env["ProgramFiles(x86)"],
    process.env.ProgramFiles,
  ]
    .filter(Boolean)
    .flatMap((base) => [
      path.join(base, "Microsoft Visual Studio", "18", "BuildTools", "VC", "Auxiliary", "Build"),
      path.join(base, "Microsoft Visual Studio", "2022", "BuildTools", "VC", "Auxiliary", "Build"),
      path.join(base, "Microsoft Visual Studio", "2022", "Community", "VC", "Auxiliary", "Build"),
    ]);

  for (const dir of candidates) {
    const vcvars64 = path.join(dir, "vcvars64.bat");
    const vcvars32 = path.join(dir, "vcvars32.bat");
    if (fs.existsSync(vcvars64) && fs.existsSync(vcvars32)) {
      return { vcvars64, vcvars32 };
    }
  }

  return null;
}

function ensureUnityCaptureSource() {
  const filterCpp = path.join(FILTER_DIR, "UnityCaptureFilter.cpp");
  if (fs.existsSync(filterCpp)) return;

  console.log("[build-unity-capture] Cloning Unity Capture source...");
  fs.mkdirSync(DRIVERS, { recursive: true });
  execSync(`git clone --depth 1 ${REPO_URL} "${path.join(DRIVERS, "unity-capture-src")}"`, {
    stdio: "inherit",
  });
}

function copyInstallScripts() {
  fs.mkdirSync(UNITY_DEST, { recursive: true });
  for (const entry of fs.readdirSync(UNITY_SRC_INSTALL, { withFileTypes: true })) {
    if (entry.isDirectory() || entry.name.endsWith(".dll")) continue;
    fs.copyFileSync(
      path.join(UNITY_SRC_INSTALL, entry.name),
      path.join(UNITY_DEST, entry.name)
    );
  }

  const templateInstaller = path.join(ROOT, "scripts", "templates", "InstallInspireTech.bat");
  if (fs.existsSync(templateInstaller)) {
    fs.copyFileSync(templateInstaller, path.join(UNITY_DEST, "InstallInspireTech.bat"));
  }

  const templatePromote = path.join(ROOT, "scripts", "templates", "PromoteUnityCapture.bat");
  if (fs.existsSync(templatePromote)) {
    fs.copyFileSync(templatePromote, path.join(UNITY_DEST, "PromoteUnityCapture.bat"));
  }
}

function copyBuiltDlls() {
  const dll64 = path.join(FILTER_DIR, "Build", "Release-UnityCaptureFilter64", "UnityCaptureFilter64.dll");
  const dll32 = path.join(FILTER_DIR, "Build", "Release-UnityCaptureFilter32", "UnityCaptureFilter32.dll");

  if (!fs.existsSync(dll64) || !fs.existsSync(dll32)) {
    throw new Error("Built Unity Capture DLLs were not found after MSBuild.");
  }

  fs.writeFileSync(path.join(UNITY_DEST, "UnityCaptureFilter64.dll"), fs.readFileSync(dll64));
  fs.writeFileSync(path.join(UNITY_DEST, "UnityCaptureFilter32.dll"), fs.readFileSync(dll32));
}

function fallbackToStockDlls() {
  console.warn("[build-unity-capture] Falling back to stock Unity Capture DLLs from upstream Install/");
  copyInstallScripts();
  fs.copyFileSync(
    path.join(UNITY_SRC_INSTALL, "UnityCaptureFilter64.dll"),
    path.join(UNITY_DEST, "UnityCaptureFilter64.dll")
  );
  fs.copyFileSync(
    path.join(UNITY_SRC_INSTALL, "UnityCaptureFilter32.dll"),
    path.join(UNITY_DEST, "UnityCaptureFilter32.dll")
  );
}

function buildUnityCapturePortrait() {
  ensureUnityCaptureSource();

  const { patchUnityCapturePortrait } = require("./patch-unity-capture-portrait");
  if (!patchUnityCapturePortrait()) {
    throw new Error("Failed to patch Unity Capture for portrait resolutions.");
  }

  const vcvars = findVcVars();
  if (!vcvars) {
    fallbackToStockDlls();
    return false;
  }

  const toolsets = ["v145", "v143", "v142", "v141"];
  let built = false;

  for (const toolset of toolsets) {
    try {
      console.log(`[build-unity-capture] Building portrait driver with PlatformToolset=${toolset}...`);
      execSync(
        `cmd /c "\"${vcvars.vcvars64}\" && msbuild \"${PROJ}\" /p:Configuration=Release /p:Platform=x64 /p:PlatformToolset=${toolset} /m /v:minimal"`,
        { stdio: "inherit" }
      );
      execSync(
        `cmd /c "\"${vcvars.vcvars32}\" && msbuild \"${PROJ}\" /p:Configuration=Release /p:Platform=Win32 /p:PlatformToolset=${toolset} /m /v:minimal"`,
        { stdio: "inherit" }
      );
      built = true;
      break;
    } catch (error) {
      console.warn(`[build-unity-capture] Toolset ${toolset} failed.`);
    }
  }

  if (!built) {
    fallbackToStockDlls();
    return false;
  }

  copyInstallScripts();
  copyBuiltDlls();
  console.log("[build-unity-capture] Portrait-capable Unity Capture DLLs ready.");
  return true;
}

if (require.main === module) {
  buildUnityCapturePortrait();
}

module.exports = { buildUnityCapturePortrait };
