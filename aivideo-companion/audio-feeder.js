const { spawn } = require("child_process");
const { getAudioFeederCommand, VIRTUAL_MIC_INPUT_HINT } = require("./paths");

let audioFeeder = null;
let audioSampleRate = null;

function startAudioFeeder(sampleRate) {
  if (audioFeeder && !audioFeeder.killed && audioSampleRate === sampleRate) {
    return true;
  }

  stopAudioFeeder();

  const feeder = getAudioFeederCommand();
  if (!feeder) {
    console.error(
      "[audio-feeder] No audio feeder found. Build with npm run build:feeders or install Python + sounddevice."
    );
    return false;
  }

  const args = [
    ...feeder.args,
    "--sample-rate",
    String(sampleRate),
    "--device-hint",
    VIRTUAL_MIC_INPUT_HINT,
  ];

  audioFeeder = spawn(feeder.command, args, {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  audioSampleRate = sampleRate;

  audioFeeder.stdout.on("data", (data) => {
    console.log(`[audio_feeder] ${data.toString().trim()}`);
  });
  audioFeeder.stderr.on("data", (data) => {
    console.error(`[audio_feeder] ${data.toString().trim()}`);
  });
  audioFeeder.on("exit", (code) => {
    console.log(`[audio_feeder] exited with code ${code}`);
    audioFeeder = null;
    audioSampleRate = null;
  });

  return true;
}

function sendAudioToFeeder(buffer) {
  if (!audioFeeder || audioFeeder.killed) return;
  const header = Buffer.alloc(4);
  header.writeUInt32BE(buffer.length, 0);
  audioFeeder.stdin.write(header);
  audioFeeder.stdin.write(buffer);
}

function stopAudioFeeder() {
  if (audioFeeder) {
    audioFeeder.kill();
    audioFeeder = null;
    audioSampleRate = null;
  }
}

module.exports = {
  startAudioFeeder,
  sendAudioToFeeder,
  stopAudioFeeder,
};
