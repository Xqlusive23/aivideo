const { spawn } = require("child_process");
const { VIRTUAL_CAMERA_NAME, getFeederCommand } = require("./paths");

const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 720;
const FRAME_FPS = 20;

let pythonFeeder = null;
let frameWidth = DEFAULT_WIDTH;
let frameHeight = DEFAULT_HEIGHT;
let stdinBroken = false;
let writePaused = false;
let pendingFrame = null;

function attachStdinGuards(child) {
  if (!child?.stdin) return;
  child.stdin.on("error", (err) => {
    const code = err?.code || "";
    // Feeder exited or pipe closed — never let this become an uncaught Electron dialog.
    if (code === "EOF" || code === "EPIPE" || code === "UNKNOWN" || code === "ECONNRESET") {
      stdinBroken = true;
      console.warn(`[feeder] stdin write failed (${code}) — virtual camera feeder will restart on next configure`);
      return;
    }
    console.warn("[feeder] stdin error:", err?.message || err);
    stdinBroken = true;
  });
}

function startFeeder(width = frameWidth, height = frameHeight) {
  frameWidth = width;
  frameHeight = height;
  stopFeeder();
  stdinBroken = false;
  writePaused = false;
  pendingFrame = null;

  const feeder = getFeederCommand();
  if (!feeder) {
    console.error(
      "[feeder] No virtual camera feeder found. Build with npm run build:feeder or install Python + pyvirtualcam."
    );
    return false;
  }

  const args = [
    ...feeder.args,
    "--width",
    String(frameWidth),
    "--height",
    String(frameHeight),
    "--fps",
    String(FRAME_FPS),
    "--device",
    VIRTUAL_CAMERA_NAME,
  ];

  const child = spawn(feeder.command, args, {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  pythonFeeder = child;
  attachStdinGuards(child);

  child.stdout.on("data", (data) => {
    console.log(`[virtualcam_feeder] ${data.toString().trim()}`);
  });
  child.stderr.on("data", (data) => {
    console.error(`[virtualcam_feeder] ${data.toString().trim()}`);
  });
  child.on("error", (err) => {
    console.error("[feeder] spawn error:", err?.message || err);
    if (pythonFeeder === child) {
      pythonFeeder = null;
      stdinBroken = true;
    }
  });
  child.on("exit", (code) => {
    console.log(`[virtualcam_feeder] exited with code ${code}`);
    if (pythonFeeder === child) {
      pythonFeeder = null;
      stdinBroken = true;
    }
  });

  console.log(`[feeder] Virtual camera started at ${frameWidth}x${frameHeight}@${FRAME_FPS}fps`);
  return true;
}

function configureFeeder(width, height) {
  const nextWidth = Number(width) || DEFAULT_WIDTH;
  const nextHeight = Number(height) || DEFAULT_HEIGHT;
  if (
    pythonFeeder &&
    !pythonFeeder.killed &&
    !stdinBroken &&
    nextWidth === frameWidth &&
    nextHeight === frameHeight
  ) {
    return true;
  }
  return startFeeder(nextWidth, nextHeight);
}

function flushPendingFrame() {
  writePaused = false;
  if (!pendingFrame) return;
  const next = pendingFrame;
  pendingFrame = null;
  sendFrameToFeeder(next);
}

function sendFrameToFeeder(buffer) {
  if (!pythonFeeder || pythonFeeder.killed || stdinBroken) return;
  if (!pythonFeeder.stdin || pythonFeeder.stdin.destroyed) {
    stdinBroken = true;
    return;
  }
  if (writePaused) {
    // Keep only the latest frame while the pipe is backed up.
    pendingFrame = buffer;
    return;
  }

  try {
    const header = Buffer.alloc(4);
    header.writeUInt32BE(buffer.length, 0);
    const okHeader = pythonFeeder.stdin.write(header);
    const okBody = pythonFeeder.stdin.write(buffer);
    if (!okHeader || !okBody) {
      writePaused = true;
      pythonFeeder.stdin.once("drain", flushPendingFrame);
    }
  } catch (err) {
    stdinBroken = true;
    console.warn("[feeder] sendFrame failed:", err?.message || err);
  }
}

function stopFeeder() {
  if (pythonFeeder) {
    try {
      if (pythonFeeder.stdin && !pythonFeeder.stdin.destroyed) {
        pythonFeeder.stdin.end();
      }
    } catch {
      // ignore
    }
    try {
      pythonFeeder.kill();
    } catch {
      // ignore
    }
    pythonFeeder = null;
  }
  stdinBroken = false;
  writePaused = false;
  pendingFrame = null;
}

function getFeederDimensions() {
  return { width: frameWidth, height: frameHeight };
}

module.exports = {
  startFeeder,
  configureFeeder,
  sendFrameToFeeder,
  stopFeeder,
  getFeederDimensions,
};
