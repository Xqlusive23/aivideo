const { spawn } = require("child_process");
const { VIRTUAL_CAMERA_NAME, getFeederCommand } = require("./paths");

const DEFAULT_WIDTH = 1920;
const DEFAULT_HEIGHT = 1080;
const FRAME_FPS = 20;

let pythonFeeder = null;
let frameWidth = DEFAULT_WIDTH;
let frameHeight = DEFAULT_HEIGHT;

function startFeeder(width = frameWidth, height = frameHeight) {
  frameWidth = width;
  frameHeight = height;
  stopFeeder();

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

  child.stdout.on("data", (data) => {
    console.log(`[virtualcam_feeder] ${data.toString().trim()}`);
  });
  child.stderr.on("data", (data) => {
    console.error(`[virtualcam_feeder] ${data.toString().trim()}`);
  });
  child.on("exit", (code) => {
    console.log(`[virtualcam_feeder] exited with code ${code}`);
    if (pythonFeeder === child) {
      pythonFeeder = null;
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
    nextWidth === frameWidth &&
    nextHeight === frameHeight
  ) {
    return true;
  }
  return startFeeder(nextWidth, nextHeight);
}

function sendFrameToFeeder(buffer) {
  if (!pythonFeeder || pythonFeeder.killed) return;
  const header = Buffer.alloc(4);
  header.writeUInt32BE(buffer.length, 0);
  pythonFeeder.stdin.write(header);
  pythonFeeder.stdin.write(buffer);
}

function stopFeeder() {
  if (pythonFeeder) {
    pythonFeeder.kill();
    pythonFeeder = null;
  }
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
