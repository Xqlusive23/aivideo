class PCMCaptureProcessor extends AudioWorkletProcessor {
    constructor(options) {
      super();
      const { targetSampleRate = 16000, frameSamples = 640 } = options.processorOptions || {};
      this.targetSampleRate = targetSampleRate;
      this.frameSamples = frameSamples;
      // `sampleRate` is a global inside AudioWorkletGlobalScope — the
      // AudioContext's native rate (usually 44100 or 48000).
      this.resampleRatio = this.targetSampleRate / sampleRate;
      this.buffer = [];
      this.resampleAccumulator = 0;
    }
  
    process(inputs) {
      const input = inputs[0];
      const channelData = input && input[0];
      if (!channelData) return true;
  
      // Simple decimation-based downsampling (no anti-aliasing filter — fine
      // for speech/RVC input, not hi-fi audio production).
      for (let i = 0; i < channelData.length; i++) {
        this.resampleAccumulator += this.resampleRatio;
        if (this.resampleAccumulator >= 1) {
          this.buffer.push(channelData[i]);
          this.resampleAccumulator -= 1;
        }
      }
  
      while (this.buffer.length >= this.frameSamples) {
        const frame = this.buffer.splice(0, this.frameSamples);
        const int16 = new Int16Array(this.frameSamples);
        for (let j = 0; j < this.frameSamples; j++) {
          const s = Math.max(-1, Math.min(1, frame[j]));
          int16[j] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
        // Transfer ownership of the buffer to avoid a copy
        this.port.postMessage(int16.buffer, [int16.buffer]);
      }
  
      return true; // keep processor alive
    }
  }
  
  registerProcessor('pcm-capture-processor', PCMCaptureProcessor);