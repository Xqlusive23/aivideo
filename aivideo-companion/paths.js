const { app } = require("electron");
const fs = require("fs");
const path = require("path");

const VIRTUAL_CAMERA_NAME = "InspireTech Camera";
const VIRTUAL_MIC_INPUT_HINT = "CABLE Input";
const VIRTUAL_MIC_OUTPUT_NAME = "CABLE Output (VB-Audio Virtual Cable)";

// Packaged builds load the live studio from here so UI/voice fixes deploy with the
// website — no new installer for every frontend change. Override for staging/tests.
const PRODUCTION_APP_URL =
  process.env.INSPIRETECH_APP_URL || "https://www.inspirestream.xyz/#/app";

function isDevMode() {
  return (
    process.env.INSPIRETECH_DEV === "1" ||
    (!app.isPackaged && process.env.INSPIRETECH_DEV !== "0")
  );
}

function getResourcePath(...segments) {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, ...segments);
  }
  return path.join(__dirname, "resources", ...segments);
}

function getDriversPath(...segments) {
  return getResourcePath("drivers", ...segments);
}

function getSetupStatePath() {
  return path.join(app.getPath("userData"), "setup-state.json");
}

function getAppUrl() {
  if (process.env.INSPIRETECH_URL) {
    return process.env.INSPIRETECH_URL;
  }
  if (isDevMode()) {
    return "http://localhost:5173/#/app";
  }
  return PRODUCTION_APP_URL;
}

function getFeederCommand() {
  const packagedExe = getResourcePath("feeder", "virtualcam_feeder.exe");
  if (fs.existsSync(packagedExe)) {
    return { command: packagedExe, args: [], usePython: false };
  }

  const pythonBin = process.env.INSPIRETECH_PYTHON || "python";
  const scriptPath = path.join(__dirname, "virtualcam_feeder.py");
  if (fs.existsSync(scriptPath)) {
    return { command: pythonBin, args: [scriptPath], usePython: true };
  }

  return null;
}

function getAudioFeederCommand() {
  const packagedExe = getResourcePath("feeder", "audio_feeder.exe");
  if (fs.existsSync(packagedExe)) {
    return { command: packagedExe, args: [], usePython: false };
  }

  const pythonBin = process.env.INSPIRETECH_PYTHON || "python";
  const scriptPath = path.join(__dirname, "audio_feeder.py");
  if (fs.existsSync(scriptPath)) {
    return { command: pythonBin, args: [scriptPath], usePython: true };
  }

  return null;
}

function getUnityCaptureInstallDir() {
  const bundled = getDriversPath("unity-capture");
  if (fs.existsSync(path.join(bundled, "UnityCaptureFilter64.dll"))) {
    return bundled;
  }

  const devSrc = getDriversPath("unity-capture-src", "Install");
  if (fs.existsSync(path.join(devSrc, "UnityCaptureFilter64.dll"))) {
    return devSrc;
  }

  return null;
}

function getVbCableInstaller() {
  const candidates = [
    getDriversPath("vb-cable", "VBCABLE_Setup_x64.exe"),
    getDriversPath("vb-cable", "VBCABLE_Setup.exe"),
    getDriversPath("vb-cable", "setup.exe"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

module.exports = {
  VIRTUAL_CAMERA_NAME,
  VIRTUAL_MIC_INPUT_HINT,
  VIRTUAL_MIC_OUTPUT_NAME,
  isDevMode,
  getResourcePath,
  getDriversPath,
  getSetupStatePath,
  getAppUrl,
  getFeederCommand,
  getAudioFeederCommand,
  getUnityCaptureInstallDir,
  getVbCableInstaller,
};
