const { BrowserWindow, ipcMain, shell } = require("electron");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const {
  VIRTUAL_CAMERA_NAME,
  getSetupStatePath,
  getUnityCaptureInstallDir,
  getVbCableInstaller,
} = require("./paths");

const SETUP_CHANNEL = "inspiretech:setup";
const UAC_CANCELLED_EXIT_CODE = 1223;
const VB_CABLE_SUCCESS_EXIT_CODES = [0, 3010, 1641];

function readSetupState() {
  try {
    const raw = fs.readFileSync(getSetupStatePath(), "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function writeSetupState(state) {
  fs.mkdirSync(path.dirname(getSetupStatePath()), { recursive: true });
  fs.writeFileSync(getSetupStatePath(), JSON.stringify(state, null, 2), "utf8");
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

async function isVirtualCameraInstalled() {
  // DirectShow virtual cameras (Unity Capture) do NOT appear in Get-PnpDevice
  // -Class Camera. Detect COM registration of the filter DLL instead.
  const script = `
    function Test-UnityCaptureRegistered {
      param([string]$DllName)
      $roots = @(
        'HKLM:\\SOFTWARE\\Classes\\CLSID',
        'HKLM:\\SOFTWARE\\WOW6432Node\\Classes\\CLSID'
      )
      foreach ($root in $roots) {
        if (-not (Test-Path $root)) { continue }
        $matches = & reg.exe query $root /s /f $DllName 2>$null
        if ($LASTEXITCODE -eq 0 -and $matches) { return $true }
      }
      return $false
    }

    $byDll = (Test-UnityCaptureRegistered 'UnityCaptureFilter64.dll') -or
             (Test-UnityCaptureRegistered 'UnityCaptureFilter32.dll')
    if ($byDll) { 'true'; exit 0 }

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

function runElevatedError(exitCode, stepLabel) {
  if (exitCode === UAC_CANCELLED_EXIT_CODE) {
    return new Error(
      `${stepLabel}: installation cancelled. Click Install again and approve the Windows UAC prompt.`
    );
  }
  return new Error(
    `${stepLabel} failed (exit code ${exitCode}). Approve UAC, ensure you have administrator rights, and try again.`
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

async function installVirtualCamera() {
  const stepLabel = "InspireTech Camera (Unity Capture)";
  const installDir = getUnityCaptureInstallDir();
  if (!installDir) {
    throw new Error(
      "Unity Capture driver files are missing from this build. Re-run npm run prepare:drivers."
    );
  }

  const installerBat = path.join(installDir, "InstallInspireTech.bat");
  if (!fs.existsSync(installerBat)) {
    throw new Error(`Missing installer script: ${installerBat}`);
  }

  try {
    await runElevated("cmd.exe", ["/c", installerBat], installDir);
  } catch (error) {
    throw runElevatedError(error.code || 1, stepLabel);
  }

  const installed = await waitForDetection(isVirtualCameraInstalled);
  if (!installed) {
    throw new Error(
      `${stepLabel} was not detected after install. Reboot Windows and try again, or run the installer as Administrator from:\n${installDir}`
    );
  }
  return true;
}

async function installVirtualAudio() {
  const stepLabel = "VB-Audio Virtual Cable";
  const installer = getVbCableInstaller();
  if (!installer) {
    throw new Error(
      "VB-CABLE installer not bundled. Download from https://vb-audio.com/Cable/ and place VBCABLE_Setup_x64.exe in aivideo-companion/resources/drivers/vb-cable/ before building."
    );
  }

  const cwd = path.dirname(installer);
  const runOptions = { allowedExitCodes: VB_CABLE_SUCCESS_EXIT_CODES };

  try {
    await runElevated(installer, ["-i", "-h"], cwd, runOptions);
  } catch {
    // Silent flags are unreliable on fresh PCs — fall back to the official installer UI.
    try {
      await runElevated(installer, [], cwd, runOptions);
    } catch (error) {
      throw runElevatedError(error.code || 1, stepLabel);
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
  if (status.vbCableBundled && !status.audioInstalled) {
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
  const vbCableBundled = Boolean(getVbCableInstaller());
  const unityCaptureBundled = Boolean(getUnityCaptureInstallDir());

  return {
    cameraInstalled,
    audioInstalled,
    setupComplete: Boolean(state.setupComplete),
    vbCableBundled,
    unityCaptureBundled,
    virtualCameraName: VIRTUAL_CAMERA_NAME,
  };
}

async function needsFirstRunSetup() {
  const status = await getSetupStatus();
  if (status.setupComplete) {
    return false;
  }
  const audioRequired = status.vbCableBundled;
  return !status.cameraInstalled || (audioRequired && !status.audioInstalled);
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

  ipcMain.handle(`${SETUP_CHANNEL}:install-all`, async () => {
    const before = await getSetupStatus();

    if (!before.cameraInstalled) {
      await installVirtualCamera();
    }
    if (before.vbCableBundled && !before.audioInstalled) {
      await installVirtualAudio();
    }

    const after = await getSetupStatus();
    const message = missingDriverMessage(after);
    if (message) {
      throw new Error(message);
    }
    return after;
  });

  ipcMain.handle(`${SETUP_CHANNEL}:complete`, async () => {
    const status = await getSetupStatus();
    writeSetupState({
      setupComplete: true,
      completedAt: new Date().toISOString(),
      cameraInstalled: status.cameraInstalled,
      audioInstalled: status.audioInstalled,
    });
    return status;
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
  isVirtualCameraInstalled,
  isVirtualAudioInstalled,
};
