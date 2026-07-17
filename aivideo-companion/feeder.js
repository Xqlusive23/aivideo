const { spawn } = require("child_process");
const { VIRTUAL_CAMERA_NAME, getFeederCommand } = require("./paths");

const FRAME_WIDTH = 1280;
const FRAME_HEIGHT = 720;
const FRAME_FPS = 20;

let pythonFeeder = null;

function startFeeder() {
  if (pythonFeeder && !pythonFeeder.killed) {
    return true;
  }

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
    String(FRAME_WIDTH),
    "--height",
    String(FRAME_HEIGHT),
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

  return true;
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

module.exports = {
  startFeeder,
  sendFrameToFeeder,
  stopFeeder,
};
