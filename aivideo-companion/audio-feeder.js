const { spawn } = require("child_process");
const { getAudioFeederCommand, VIRTUAL_MIC_INPUT_HINT } = require("./paths");

let audioFeeder = null;
let audioSampleRate = null;
let stdinBroken = false;

function attachStdinGuards(child) {
  if (!child?.stdin) return;
  child.stdin.on("error", (err) => {
    const code = err?.code || "";
    if (code === "EOF" || code === "EPIPE" || code === "UNKNOWN" || code === "ECONNRESET") {
      stdinBroken = true;
      console.warn(`[audio-feeder] stdin write failed (${code})`);
      return;
    }
    console.warn("[audio-feeder] stdin error:", err?.message || err);
    stdinBroken = true;
  });
}

function startAudioFeeder(sampleRate) {
  if (audioFeeder && !audioFeeder.killed && !stdinBroken && audioSampleRate === sampleRate) {
    return true;
  }

  stopAudioFeeder();
  stdinBroken = false;

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
  attachStdinGuards(audioFeeder);

  audioFeeder.stdout.on("data", (data) => {
    console.log(`[audio_feeder] ${data.toString().trim()}`);
  });
  audioFeeder.stderr.on("data", (data) => {
    console.error(`[audio_feeder] ${data.toString().trim()}`);
  });
  audioFeeder.on("error", (err) => {
    console.error("[audio-feeder] spawn error:", err?.message || err);
    audioFeeder = null;
    audioSampleRate = null;
    stdinBroken = true;
  });
  audioFeeder.on("exit", (code) => {
    console.log(`[audio_feeder] exited with code ${code}`);
    audioFeeder = null;
    audioSampleRate = null;
    stdinBroken = true;
  });

  return true;
}

function sendAudioToFeeder(buffer) {
  if (!audioFeeder || audioFeeder.killed || stdinBroken) return;
  if (!audioFeeder.stdin || audioFeeder.stdin.destroyed) {
    stdinBroken = true;
    return;
  }
  try {
    const header = Buffer.alloc(4);
    header.writeUInt32BE(buffer.length, 0);
    audioFeeder.stdin.write(header);
    audioFeeder.stdin.write(buffer);
  } catch (err) {
    stdinBroken = true;
    console.warn("[audio-feeder] sendAudio failed:", err?.message || err);
  }
}

function stopAudioFeeder() {
  if (audioFeeder) {
    try {
      if (audioFeeder.stdin && !audioFeeder.stdin.destroyed) {
        audioFeeder.stdin.end();
      }
    } catch {
      // ignore
    }
    try {
      audioFeeder.kill();
    } catch {
      // ignore
    }
    audioFeeder = null;
    audioSampleRate = null;
  }
  stdinBroken = false;
}

module.exports = {
  startAudioFeeder,
  sendAudioToFeeder,
  stopAudioFeeder,
};
