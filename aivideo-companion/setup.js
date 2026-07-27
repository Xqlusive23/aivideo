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

function regQueryContains(rootKey, searchTerm) {
  return new Promise((resolve) => {
    execFile(
      "reg.exe",
      ["query", rootKey, "/s", "/f", searchTerm],
      { windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        resolve(!error && stdout.includes(searchTerm));
      }
    );
  });
}

function copyFileWithoutMotw(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, fs.readFileSync(src));
}

function clearMotwForDlls(dir) {
  if (!dir || !fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    if (!/^UnityCaptureFilter.*\.dll$/i.test(name)) continue;
    const full = path.join(dir, name);
    try {
      copyFileWithoutMotw(full, full);
    } catch {
      // ignore per-file failures
    }
    try {
      execFileSync(
        "cmd.exe",
        ["/c", `if exist "${full}:Zone.Identifier" del /f /q "${full}:Zone.Identifier"`],
        { windowsHide: true }
      );
    } catch {
      // best effort
    }
  }
}

function clearMotwRecursive(dir) {
  if (!dir || !fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      clearMotwRecursive(full);
      continue;
    }
    try {
      copyFileWithoutMotw(full, full);
    } catch {
      // ignore
    }
    try {
      execFileSync(
        "cmd.exe",
        ["/c", `if exist "${full}:Zone.Identifier" del /f /q "${full}:Zone.Identifier"`],
        { windowsHide: true }
      );
    } catch {
      // best effort
    }
  }
}

function releaseCameraDllLocks() {
  stopFeeder();
  for (const image of ["virtualcam_feeder.exe", "audio_feeder.exe"]) {
    try {
      execFileSync("taskkill", ["/F", "/IM", image], { windowsHide: true });
    } catch {
      // not running
    }
  }
}

function regQueryValue(rootKey, valueName = "") {
  return new Promise((resolve) => {
    const args = ["query", rootKey];
    if (valueName) args.push("/v", valueName);
    execFile("reg.exe", args, { windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      resolve(error ? "" : stdout);
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function unblockDriverFiles(dir) {
  clearMotwForDlls(dir);
}

function unblockPackageDir(dir) {
  clearMotwRecursive(dir);
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
  const clsid64 = "{5c2cd55c-92ad-4999-8666-912bd3e70010}";
  const clsidKey = `HKLM\\SOFTWARE\\Classes\\CLSID\\${clsid64}`;
  const clsidInfo = await regQueryValue(clsidKey);
  if (clsidInfo.includes(VIRTUAL_CAMERA_NAME)) {
    const inprocKey = `${clsidKey}\\InprocServer32`;
    const inproc = await regQueryValue(inprocKey);
    const dllPath = parseRegDefaultPath(inproc);
    if (dllPath && fs.existsSync(dllPath)) {
      return true;
    }
    // Name registered — treat as installed even if DLL path parsing fails.
    return true;
  }

  const searches = [
    ["HKLM\\SOFTWARE\\Classes\\CLSID", VIRTUAL_CAMERA_NAME],
    ["HKLM\\SOFTWARE\\WOW6432Node\\Classes\\CLSID", VIRTUAL_CAMERA_NAME],
  ];
  for (const [rootKey, term] of searches) {
    if (await regQueryContains(rootKey, term)) return true;
  }
  return false;
}

function parseRegDefaultPath(regOutput) {
  if (!regOutput) return "";
  const defaultMatch = regOutput.match(/\(Default\)\s+REG_SZ\s+(.+)/i);
  if (defaultMatch) return defaultMatch[1].trim();
  const lines = regOutput.split(/\r?\n/);
  for (const line of lines) {
    if (line.includes("(Default)") && line.includes("REG_SZ")) {
      return line.replace(/.*REG_SZ\s+/i, "").trim();
    }
  }
  return "";
}

async function isVirtualAudioInstalled() {
  try {
    const result = await runPowerShell(`
      $names = Get-CimInstance Win32_PnPEntity -ErrorAction SilentlyContinue |
        ForEach-Object { $_.Name }
      if ($names -match 'VB-Audio|CABLE Input|CABLE Output|Virtual Cable') { 'true' } else { 'false' }
    `);
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
      `${stepLabel} failed (exit code 1). Close Chrome and other apps using a webcam, then try again. ` +
        `If it still fails, reboot and double-click:\n${manualPath}`
    );
  }
  return new Error(
    `${stepLabel} failed (exit code ${normalizedExitCode}). Approve UAC, ensure you have administrator rights, and try again.` +
      (manualPath ? `\nManual install: ${manualPath}` : "")
  );
}

function runElevatedViaVbs(cmdLine, cwd, options = {}) {
  const { allowedExitCodes = [0], timeoutMs = 180000, exitFile = null } = options;
  const vbsPath = path.join(app.getPath("temp"), `inspiretech-elev-${Date.now()}.vbs`);
  const workDir = (cwd || app.getPath("temp")).replace(/\\/g, "\\\\");
  const escapedCmd = cmdLine.replace(/"/g, '""');
  const vbs = [
    'Set shell = CreateObject("Shell.Application")',
    `shell.ShellExecute "cmd.exe", "/c ""${escapedCmd}""", "${workDir}", "runas", 0`,
  ].join("\r\n");

  fs.writeFileSync(vbsPath, vbs, "utf8");

  return new Promise((resolve, reject) => {
    execFile("wscript.exe", ["//Nologo", vbsPath], { windowsHide: true }, () => {
      // wscript returns immediately after launching UAC — poll for completion below.
    });

    const started = Date.now();
    const poll = setInterval(() => {
      if (exitFile && fs.existsSync(exitFile)) {
        clearInterval(poll);
        try {
          fs.unlinkSync(vbsPath);
        } catch {
          // ignore
        }
        const raw = fs.readFileSync(exitFile, "utf8").trim();
        try {
          fs.unlinkSync(exitFile);
        } catch {
          // ignore
        }
        const code = parseInt(raw, 10);
        if (Number.isNaN(code)) {
          reject(
            Object.assign(new Error("Elevated install did not report an exit code."), { code: 1 })
          );
          return;
        }
        if (!allowedExitCodes.includes(code)) {
          reject(
            Object.assign(new Error(`Elevated install failed with exit code ${code}.`), { code })
          );
          return;
        }
        resolve(code);
        return;
      }

      if (Date.now() - started > timeoutMs) {
        clearInterval(poll);
        try {
          fs.unlinkSync(vbsPath);
        } catch {
          // ignore
        }
        reject(
          Object.assign(
            new Error("Installation timed out or the Windows UAC prompt was cancelled."),
            { code: UAC_CANCELLED_EXIT_CODE }
          )
        );
      }
    }, 400);
  });
}

function runElevated(command, args = [], cwd, options = {}) {
  const { allowedExitCodes = [0] } = options;
  const exitFile = path.join(app.getPath("temp"), `inspiretech-exit-${Date.now()}.txt`);
  try {
    fs.unlinkSync(exitFile);
  } catch {
    // ignore
  }
  const quotedArgs = args.map((arg) => `"${String(arg).replace(/"/g, '""')}"`).join(" ");
  const cmdLine = `"${command.replace(/"/g, '""')}"${quotedArgs ? ` ${quotedArgs}` : ""} & echo %ERRORLEVEL%> "${exitFile}"`;
  return runElevatedViaVbs(cmdLine, cwd, { ...options, allowedExitCodes, exitFile });
}

function getUninstallUnityCaptureBat() {
  const bundled = path.join(getUnityCaptureInstallDir() || "", "UninstallUnityCapture.bat");
  if (bundled && fs.existsSync(bundled)) return bundled;
  const template = path.join(__dirname, "scripts", "templates", "UninstallUnityCapture.bat");
  if (fs.existsSync(template)) return template;
  return null;
}

async function uninstallVirtualCamera(bundleDir) {
  const uninstallTemplate = getUninstallUnityCaptureBat();
  if (!uninstallTemplate) return;

  const uninstallBat = path.join(app.getPath("temp"), "inspiretech-uninstall-camera.bat");
  copyFileWithoutMotw(uninstallTemplate, uninstallBat);

  const exitFile = path.join(app.getPath("temp"), "inspiretech-uninstall-exit.txt");
  try {
    fs.unlinkSync(exitFile);
  } catch {
    // ignore
  }

  const cmdLine = `set INSPIRETECH_BUNDLE=${bundleDir.replace(/"/g, '""')}&& set INSPIRETECH_EXITFILE=${exitFile.replace(/"/g, '""')}&& "${uninstallBat.replace(/"/g, '""')}"`;

  try {
    await runElevatedViaVbs(cmdLine, app.getPath("temp"), { exitFile, allowedExitCodes: [0] });
  } catch {
    // Best effort — install will unregister again before registering.
  } finally {
    try {
      fs.unlinkSync(uninstallBat);
    } catch {
      // ignore
    }
    try {
      fs.unlinkSync(exitFile);
    } catch {
      // ignore
    }
  }
  await sleep(800);
}

function getPromoteUnityCaptureBat() {
  const bundled = path.join(getUnityCaptureInstallDir() || "", "PromoteUnityCapture.bat");
  if (bundled && fs.existsSync(bundled)) return bundled;
  const template = path.join(__dirname, "scripts", "templates", "PromoteUnityCapture.bat");
  if (fs.existsSync(template)) return template;
  return null;
}

async function prepareUnityCaptureStaging() {
  const bundleDir = getUnityCaptureInstallDir();
  if (!bundleDir) {
    throw new Error(
      "Unity Capture driver files are missing from this build. Re-run npm run prepare:drivers."
    );
  }

  releaseCameraDllLocks();
  await sleep(600);
  unblockDriverFiles(bundleDir);

  return { bundleDir };
}

async function installVirtualCamera(options = {}) {
  const { cleanReinstall = false } = options;
  const stepLabel = "InspireTech Camera (Unity Capture)";
  cleanupInstallTempFiles();

  const { bundleDir } = await prepareUnityCaptureStaging();

  if (cleanReinstall) {
    await uninstallVirtualCamera(bundleDir);
  }

  if (!cleanReinstall && (await isVirtualCameraInstalled())) {
    return true;
  }

  const manualBatPath = path.join(getStagedUnityCaptureDir(), "InstallInspireTech.bat");
  const promoteTemplate = getPromoteUnityCaptureBat();
  if (!promoteTemplate) {
    throw new Error("PromoteUnityCapture.bat is missing from this build.");
  }

  const promoteBat = path.join(app.getPath("temp"), "inspiretech-promote-camera.bat");
  copyFileWithoutMotw(promoteTemplate, promoteBat);

  const exitFile = path.join(app.getPath("temp"), "inspiretech-promote-exit.txt");
  try {
    fs.unlinkSync(exitFile);
  } catch {
    // ignore
  }

  const quotedArgs = [bundleDir, exitFile]
    .map((arg) => `"${String(arg).replace(/"/g, '""')}"`)
    .join(" ");
  const cmdLine = `"${promoteBat.replace(/"/g, '""')}" ${quotedArgs}`;

  try {
    await runElevatedViaVbs(cmdLine, app.getPath("temp"), { exitFile });
  } catch (error) {
    // Install can fail when re-registering an already-working driver — don't block the user.
    if (await isVirtualCameraInstalled()) {
      return true;
    }
    throw runElevatedError(error.code || 1, stepLabel, manualBatPath);
  } finally {
    try {
      fs.unlinkSync(promoteBat);
    } catch {
      // ignore
    }
  }

  const installed = await waitForDetection(isVirtualCameraInstalled, 12, 1000);
  if (!installed) {
    throw new Error(
      `${stepLabel} was not detected after install. Close Chrome, reboot Windows, then double-click:\n${manualBatPath}`
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

  ipcMain.handle(`${SETUP_CHANNEL}:install-camera`, async (_event, options = {}) => {
    await installVirtualCamera({ cleanReinstall: Boolean(options.cleanReinstall) });
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
        await installVirtualCamera({ cleanReinstall: forceReinstall && before.cameraInstalled });
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
