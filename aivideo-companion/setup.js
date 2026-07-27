const { app, BrowserWindow, ipcMain, shell } = require("electron");
const fs = require("fs");
const path = require("path");
const { execFile, execFileSync } = require("child_process");
const {
  VIRTUAL_CAMERA_NAME,
  getSetupStatePath,
  getUnityCaptureInstallDir,
  getStagedUnityCaptureDir,
  getVbCableBundleDir,
  getVbCableInstaller,
  isVbCableBundleComplete,
} = require("./paths");
const { stopFeeder } = require("./feeder");

const SETUP_CHANNEL = "inspiretech:setup";
const UAC_CANCELLED_EXIT_CODE = 1223;
const VB_CABLE_SUCCESS_EXIT_CODES = [0, 3010, 1641];

function readSetupState() {
  try {
    const raw = fs.readFileSync(getSetupStatePath(), "utf8");
    return { skipVirtualAudio: true, ...JSON.parse(raw) };
  } catch {
    return { skipVirtualAudio: true };
  }
}

function writeSetupState(state) {
  fs.mkdirSync(path.dirname(getSetupStatePath()), { recursive: true });
  fs.writeFileSync(getSetupStatePath(), JSON.stringify(state, null, 2), "utf8");
}

function resetSetupStateForInstall(skipVirtualAudio) {
  const state = readSetupState();
  const next = {
    ...state,
    setupComplete: false,
    skipVirtualAudio: Boolean(
      skipVirtualAudio !== undefined ? skipVirtualAudio : state.skipVirtualAudio
    ),
    lastInstallAttemptAt: new Date().toISOString(),
  };
  delete next.lastInstallError;
  writeSetupState(next);
  return next;
}

function cleanupInstallTempFiles() {
  const tempDir = app.getPath("temp");
  for (const name of [
    "inspiretech-register-camera.ps1",
    "inspiretech-unregister-camera.ps1",
    "inspiretech-promote-camera.ps1",
    "inspiretech-vb-cable",
  ]) {
    try {
      fs.unlinkSync(path.join(tempDir, name));
    } catch {
      // ignore missing or locked temp files
    }
  }
}

function runPowerShell(script) {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr || error.message));
          return;
        }
        resolve(stdout.trim());
      }
    );
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function unblockDriverFiles(dir) {
  if (!dir || !fs.existsSync(dir)) return;
  const escaped = dir.replace(/'/g, "''");
  const script = `
Get-ChildItem -LiteralPath '${escaped}' -Filter 'UnityCaptureFilter*.dll' -ErrorAction SilentlyContinue | ForEach-Object {
  Unblock-File -LiteralPath $_.FullName -ErrorAction SilentlyContinue
  $zone = "$($_.FullName):Zone.Identifier"
  if (Test-Path -LiteralPath $zone) {
    Remove-Item -LiteralPath $zone -Force -ErrorAction SilentlyContinue
  }
}
`.trim();
  try {
    execFileSync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true }
    );
  } catch {
    // Best effort — the elevated installer also clears blocks before regsvr32.
  }
}

function unblockPackageDir(dir) {
  if (!dir || !fs.existsSync(dir)) return;
  const escaped = dir.replace(/'/g, "''");
  const script = `
Get-ChildItem -LiteralPath '${escaped}' -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object {
  Unblock-File -LiteralPath $_.FullName -ErrorAction SilentlyContinue
  $zone = "$($_.FullName):Zone.Identifier"
  if (Test-Path -LiteralPath $zone) {
    Remove-Item -LiteralPath $zone -Force -ErrorAction SilentlyContinue
  }
}
`.trim();
  try {
    execFileSync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true }
    );
  } catch {
    // Best effort before the elevated VB-CABLE installer runs.
  }
}

function copyFileWithoutMotw(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, fs.readFileSync(src));
}

function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      copyFileWithoutMotw(srcPath, destPath);
    }
  }
}

async function isVirtualCameraInstalled() {
  // DirectShow virtual cameras (Unity Capture) do NOT appear in Get-PnpDevice
  // -Class Camera. Detect COM registration of the filter DLL instead.
  const script = `
    $nameMatches = & reg.exe query HKLM\\SOFTWARE\\Classes\\CLSID /s /f '${VIRTUAL_CAMERA_NAME}' 2>$null
    if ($LASTEXITCODE -eq 0 -and $nameMatches) { 'true' } else { 'false' }
  `;
  try {
    const result = await runPowerShell(script);
    return result.includes("true");
  } catch {
    return false;
  }
}

async function isVirtualAudioInstalled() {
  const script = `
    $names = Get-CimInstance Win32_PnPEntity -ErrorAction SilentlyContinue |
      ForEach-Object { $_.Name }
    if ($names -match 'VB-Audio|CABLE Input|CABLE Output|Virtual Cable') { 'true' } else { 'false' }
  `;
  try {
    const result = await runPowerShell(script);
    return result.includes("true");
  } catch {
    return false;
  }
}

async function waitForDetection(checkFn, attempts = 8, delayMs = 750) {
  for (let i = 0; i < attempts; i += 1) {
    if (await checkFn()) return true;
    if (i < attempts - 1) await sleep(delayMs);
  }
  return checkFn();
}

function runElevatedError(exitCode, stepLabel, manualPath = "") {
  const normalizedExitCode = exitCode >>> 0 === 4294967295 ? -1 : exitCode;
  if (normalizedExitCode === UAC_CANCELLED_EXIT_CODE) {
    return new Error(
      `${stepLabel}: installation cancelled. Click Install again and approve the Windows UAC prompt.`
    );
  }
  if (normalizedExitCode === 3) {
    return new Error(
      `${stepLabel} failed (exit code 3 — Windows blocked driver registration). ` +
        `Approve UAC, then try again. If it still fails, right-click Run as administrator:` +
        (manualPath ? `\n${manualPath}` : "")
    );
  }
  if (normalizedExitCode === 1) {
    return new Error(
      `${stepLabel} failed (exit code 1 — Windows may be blocking the driver DLL as downloaded from the internet). ` +
        `Click Continue again to retry (we unblock automatically). If it still fails, reboot and retry, or run as administrator:` +
        (manualPath ? `\n${manualPath}` : "")
    );
  }
  return new Error(
    `${stepLabel} failed (exit code ${normalizedExitCode}). Approve UAC, ensure you have administrator rights, and try again.` +
      (manualPath ? `\nManual install: ${manualPath}` : "")
  );
}

function runElevated(command, args = [], cwd, options = {}) {
  const { allowedExitCodes = [0] } = options;
  const escapePs = (value) => value.replace(/'/g, "''");
  const argList =
    args.length > 0
      ? `-ArgumentList ${args.map((arg) => `'${escapePs(String(arg))}'`).join(", ")}`
      : "";

  const script = `
    $p = Start-Process -FilePath '${escapePs(command)}' ${argList} -WorkingDirectory '${escapePs(cwd)}' -Verb RunAs -Wait -PassThru -WindowStyle Normal
    if ($null -eq $p) { exit ${UAC_CANCELLED_EXIT_CODE} }
    exit $p.ExitCode
  `;

  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: false },
      (error) => {
        const exitCode = error?.code || 0;
        if (error && !allowedExitCodes.includes(exitCode)) {
          reject(error);
          return;
        }
        resolve(exitCode);
      }
    );
  });
}

async function prepareUnityCaptureStaging() {
  const bundleDir = getUnityCaptureInstallDir();
  if (!bundleDir) {
    throw new Error(
      "Unity Capture driver files are missing from this build. Re-run npm run prepare:drivers."
    );
  }

  stopFeeder();
  await sleep(400);

  const pendingDir = path.join(app.getPath("temp"), "inspiretech-unity-capture-pending");
  fs.rmSync(pendingDir, { recursive: true, force: true });
  fs.mkdirSync(pendingDir, { recursive: true });

  const required = ["UnityCaptureFilter64.dll", "InstallInspireTech.bat"];
  unblockDriverFiles(bundleDir);
  for (const file of required) {
    const src = path.join(bundleDir, file);
    if (!fs.existsSync(src)) {
      throw new Error(`Missing driver file: ${src}`);
    }
    copyFileWithoutMotw(src, path.join(pendingDir, file));
  }

  const dll32 = path.join(bundleDir, "UnityCaptureFilter32.dll");
  if (fs.existsSync(dll32)) {
    copyFileWithoutMotw(dll32, path.join(pendingDir, "UnityCaptureFilter32.dll"));
  }

  unblockDriverFiles(pendingDir);

  return {
    pendingDir,
    stageDir: getStagedUnityCaptureDir(),
  };
}

async function installVirtualCamera() {
  const stepLabel = "InspireTech Camera (Unity Capture)";
  cleanupInstallTempFiles();

  const { pendingDir, stageDir } = await prepareUnityCaptureStaging();
  const manualBatPath = path.join(stageDir, "InstallInspireTech.bat");
  const ps1Path = path.join(app.getPath("temp"), "inspiretech-promote-camera.ps1");
  const ps1Content = `
$ErrorActionPreference = 'Stop'
$pending = '${pendingDir.replace(/'/g, "''")}'
$stage = '${stageDir.replace(/'/g, "''")}'
New-Item -ItemType Directory -Force -Path $stage | Out-Null

function Clear-DriverBlocks([string]$dir) {
  Get-ChildItem -LiteralPath $dir -Filter 'UnityCaptureFilter*.dll' -ErrorAction SilentlyContinue | ForEach-Object {
    Unblock-File -LiteralPath $_.FullName -ErrorAction SilentlyContinue
    $zone = "$($_.FullName):Zone.Identifier"
    if (Test-Path -LiteralPath $zone) {
      Remove-Item -LiteralPath $zone -Force -ErrorAction SilentlyContinue
    }
  }
}

$regsvr64 = Join-Path $env:SystemRoot 'System32\\regsvr32.exe'
$regsvr32 = Join-Path $env:SystemRoot 'SysWOW64\\regsvr32.exe'

function Unregister-Dll($regsvr, $dll) {
  if (-not (Test-Path $regsvr) -or -not (Test-Path $dll)) { return }
  & $regsvr /s /u $dll | Out-Null
}

$old64 = Join-Path $stage 'UnityCaptureFilter64.dll'
$old32 = Join-Path $stage 'UnityCaptureFilter32.dll'
Unregister-Dll $regsvr64 $old64
Unregister-Dll $regsvr32 $old32
Start-Sleep -Milliseconds 750

Get-ChildItem -LiteralPath $pending | ForEach-Object {
  Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $stage $_.Name) -Force
}

Clear-DriverBlocks $stage
Clear-DriverBlocks $pending

$bat = Join-Path $stage 'InstallInspireTech.bat'
if (-not (Test-Path -LiteralPath $bat)) {
  Write-Error "Missing InstallInspireTech.bat in $stage"
  exit 1
}

Push-Location $stage
try {
  & cmd.exe /c InstallInspireTech.bat
  exit $LASTEXITCODE
} finally {
  Pop-Location
}
`.trim();

  fs.writeFileSync(ps1Path, ps1Content, "utf8");
  try {
    await runElevated(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1Path],
      stageDir
    );
  } catch (error) {
    throw runElevatedError(error.code || 1, stepLabel, manualBatPath);
  } finally {
    try {
      fs.unlinkSync(ps1Path);
    } catch {
      // temp script may remain if UAC was cancelled mid-run
    }
    try {
      fs.rmSync(pendingDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures
    }
  }

  const installed = await waitForDetection(isVirtualCameraInstalled, 12, 1000);
  if (!installed) {
    throw new Error(
      `${stepLabel} was not detected after install. Reboot Windows and try again, or right-click Run as administrator:\n${manualBatPath}`
    );
  }
  return true;
}

async function prepareVbCableStaging() {
  const bundleDir = getVbCableBundleDir();
  if (!isVbCableBundleComplete(bundleDir)) {
    throw new Error(
      "VB-CABLE driver package is incomplete in this build (missing .inf files). " +
        "Extract the full VB-CABLE ZIP into aivideo-companion/resources/drivers/vb-cable/ before building, " +
        "or run npm run prepare:drivers. Download from https://vb-audio.com/Cable/"
    );
  }

  const stagingDir = path.join(app.getPath("temp"), "inspiretech-vb-cable");
  fs.rmSync(stagingDir, { recursive: true, force: true });
  copyDirRecursive(bundleDir, stagingDir);
  unblockPackageDir(stagingDir);

  const installer = getVbCableInstaller(stagingDir);
  if (!installer) {
    throw new Error("VB-CABLE installer missing after staging.");
  }

  return { stagingDir, installer };
}

async function installVirtualAudio() {
  const stepLabel = "VB-Audio Virtual Cable";
  const { stagingDir, installer } = await prepareVbCableStaging();
  const runOptions = { allowedExitCodes: VB_CABLE_SUCCESS_EXIT_CODES };

  try {
    try {
      await runElevated(installer, ["-i", "-h"], stagingDir, runOptions);
    } catch {
      // Silent flags are unreliable on fresh PCs — fall back to the official installer UI.
      await runElevated(installer, [], stagingDir, runOptions);
    }
  } catch (error) {
    throw runElevatedError(
      error.code || 1,
      stepLabel,
      `${installer}\nRun from an extracted folder (not directly from a ZIP). Reboot if the installer asks.`
    );
  } finally {
    try {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures
    }
  }

  const installed = await waitForDetection(isVirtualAudioInstalled, 12, 1000);
  if (!installed) {
    throw new Error(
      `${stepLabel} was not detected after install. Complete the installer if it is still open, reboot Windows, then try again.`
    );
  }
  return true;
}

function missingDriverMessage(status) {
  const missing = [];
  if (!status.cameraInstalled) {
    missing.push(`${VIRTUAL_CAMERA_NAME} (virtual webcam)`);
  }
  if (status.vbCableBundled && !status.skipVirtualAudio && !status.audioInstalled) {
    missing.push("VB-Audio Virtual Cable");
  }
  if (missing.length === 0) return null;
  return `Still missing: ${missing.join(" and ")}. Approve the UAC prompt when installing, then try again.`;
}

async function getSetupStatus() {
  const [cameraInstalled, audioInstalled] = await Promise.all([
    isVirtualCameraInstalled(),
    isVirtualAudioInstalled(),
  ]);

  const state = readSetupState();
  const vbCableBundled = isVbCableBundleComplete();
  const unityCaptureBundled = Boolean(getUnityCaptureInstallDir());
  const skipVirtualAudio = Boolean(state.skipVirtualAudio);

  return {
    cameraInstalled,
    audioInstalled,
    setupComplete: Boolean(state.setupComplete),
    skipVirtualAudio,
    vbCableBundled,
    unityCaptureBundled,
    virtualCameraName: VIRTUAL_CAMERA_NAME,
    manualCameraInstallBat: path.join(getStagedUnityCaptureDir(), "InstallInspireTech.bat"),
  };
}

async function needsFirstRunSetup() {
  const status = await getSetupStatus();
  const audioRequired = status.vbCableBundled && !status.skipVirtualAudio;
  const driversMissing =
    !status.cameraInstalled || (audioRequired && !status.audioInstalled);
  // Re-show the wizard if drivers are still missing, even when setupComplete
  // was set incorrectly or an earlier install was interrupted.
  return driversMissing;
}

function createSetupWindow() {
  const iconPath = path.join(__dirname, "build", "icon.png");
  const win = new BrowserWindow({
    width: 560,
    height: 520,
    resizable: false,
    maximizable: false,
    minimizable: true,
    autoHideMenuBar: true,
    title: "InspireTech Setup",
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      preload: path.join(__dirname, "setup", "setup-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, "setup", "setup.html"));
  win.setMenuBarVisibility(false);
  return win;
}

function registerSetupIpc() {
  ipcMain.handle(`${SETUP_CHANNEL}:status`, async () => getSetupStatus());

  ipcMain.handle(`${SETUP_CHANNEL}:install-camera`, async () => {
    await installVirtualCamera();
    return getSetupStatus();
  });

  ipcMain.handle(`${SETUP_CHANNEL}:install-audio`, async () => {
    await installVirtualAudio();
    return getSetupStatus();
  });

  ipcMain.handle(`${SETUP_CHANNEL}:install-all`, async (_event, options = {}) => {
    const state = readSetupState();
    const skipAudio = Boolean(options.skipAudio ?? state.skipVirtualAudio);
    const forceReinstall = Boolean(options.forceReinstall);
    resetSetupStateForInstall(skipAudio);
    cleanupInstallTempFiles();

    const before = await getSetupStatus();

    try {
      if (!before.cameraInstalled || forceReinstall) {
        await installVirtualCamera();
      }
      if (!skipAudio && before.vbCableBundled && (!before.audioInstalled || forceReinstall)) {
        try {
          await installVirtualAudio();
        } catch (audioError) {
          const afterCamera = await getSetupStatus();
          if (afterCamera.cameraInstalled) {
            throw new Error(
              `InspireTech Camera is installed. VB-CABLE failed: ${audioError.message || audioError}`
            );
          }
          throw audioError;
        }
      }

      const after = await getSetupStatus();
      const message = missingDriverMessage(after);
      if (message) {
        throw new Error(message);
      }
      return after;
    } catch (error) {
      writeSetupState({
        ...readSetupState(),
        setupComplete: false,
        lastInstallError: String(error.message || error),
        lastInstallFailedAt: new Date().toISOString(),
      });
      throw error;
    }
  });

  ipcMain.handle(`${SETUP_CHANNEL}:reset-for-install`, async (_event, options = {}) => {
    const state = readSetupState();
    const skipAudio = Boolean(options.skipAudio ?? state.skipVirtualAudio);
    resetSetupStateForInstall(skipAudio);
    cleanupInstallTempFiles();
    return getSetupStatus();
  });

  ipcMain.handle(`${SETUP_CHANNEL}:complete`, async () => {
    const status = await getSetupStatus();
    writeSetupState({
      setupComplete: true,
      completedAt: new Date().toISOString(),
      cameraInstalled: status.cameraInstalled,
      audioInstalled: status.audioInstalled,
      skipVirtualAudio: status.skipVirtualAudio,
    });
    return status;
  });

  ipcMain.handle(`${SETUP_CHANNEL}:set-skip-audio`, async (_event, skipAudio) => {
    const state = readSetupState();
    writeSetupState({ ...state, skipVirtualAudio: Boolean(skipAudio) });
    return getSetupStatus();
  });

  ipcMain.handle(`${SETUP_CHANNEL}:open-external`, async (_event, url) => {
    await shell.openExternal(url);
  });
}

function showSetupWizard() {
  return new Promise((resolve) => {
    const win = createSetupWindow();
    win.on("closed", () => resolve());
  });
}

module.exports = {
  registerSetupIpc,
  needsFirstRunSetup,
  showSetupWizard,
  getSetupStatus,
  readSetupState,
  writeSetupState,
  resetSetupStateForInstall,
  cleanupInstallTempFiles,
  isVirtualCameraInstalled,
  isVirtualAudioInstalled,
};
