"""
audio_feeder.py — receives mono Int16 PCM from Electron over stdin and plays
it to VB-CABLE Input so calling apps hear it on CABLE Output.

Protocol (matches video feeder framing):
    [4 bytes: big-endian uint32 byte length] [length bytes of Int16 LE mono PCM]
repeated until stdin closes.

Play TO "CABLE Input (VB-Audio Virtual Cable)" — that routes to the virtual
mic device other apps select as "CABLE Output".
"""

import argparse
import struct
import sys
import threading

import numpy as np
import sounddevice as sd

DEFAULT_DEVICE_HINT = "CABLE Input"


def read_exact(stream, n):
    buf = b""
    while len(buf) < n:
        chunk = stream.read(n - len(buf))
        if not chunk:
            return None
        buf += chunk
    return buf


def find_output_device(hint):
    hint_lower = hint.lower()
    for index, device in enumerate(sd.query_devices()):
        name = device.get("name", "")
        if hint_lower in name.lower() and device.get("max_output_channels", 0) > 0:
            return index, name
    return None, None


class PcmRingBuffer:
    def __init__(self):
        self._buffer = np.array([], dtype=np.float32)
        self._lock = threading.Lock()

    def push(self, samples):
        with self._lock:
            if len(self._buffer) == 0:
                self._buffer = samples
            else:
                self._buffer = np.concatenate((self._buffer, samples))

    def read(self, frames):
        with self._lock:
            if len(self._buffer) < frames:
                return None
            chunk = self._buffer[:frames].copy()
            self._buffer = self._buffer[frames:]
            return chunk


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--sample-rate", type=int, required=True)
    parser.add_argument("--device-hint", default=DEFAULT_DEVICE_HINT)
    parser.add_argument("--channels", type=int, default=1)
    args = parser.parse_args()

    device_index, device_name = find_output_device(args.device_hint)
    if device_index is None:
        print(
            f"❌ No output device matching '{args.device_hint}' found. "
            "Install VB-CABLE and select CABLE Output in your calling app.",
            flush=True,
        )
        sys.exit(1)

    ring = PcmRingBuffer()
    running = threading.Event()
    running.set()

    def callback(outdata, frames, _time, status):
        if status:
            print(f"[audio_feeder] stream status: {status}", flush=True)
        chunk = ring.read(frames)
        if chunk is None:
            outdata.fill(0)
            return
        outdata[:, 0] = chunk
        if args.channels > 1:
            for ch in range(1, args.channels):
                outdata[:, ch] = chunk

    def stdin_reader():
        stdin = sys.stdin.buffer
        while running.is_set():
            header = read_exact(stdin, 4)
            if header is None:
                break
            (length,) = struct.unpack(">I", header)
            if length == 0:
                print("⚠️  Invalid PCM chunk length 0, skipping.", flush=True)
                continue
            payload = read_exact(stdin, length)
            if payload is None:
                break
            if length % 2 != 0:
                print(f"⚠️  Invalid PCM chunk length {length}, discarding payload.", flush=True)
                continue
            samples = np.frombuffer(payload, dtype=np.int16).astype(np.float32) / 32768.0
            ring.push(samples)

    print(
        f"Starting virtual mic feeder {args.sample_rate}Hz → {device_name}",
        flush=True,
    )
    print(
        "In Zoom/Discord/Telegram set Microphone to: CABLE Output (VB-Audio Virtual Cable)",
        flush=True,
    )

    reader = threading.Thread(target=stdin_reader, daemon=True)
    reader.start()

    try:
        with sd.OutputStream(
            device=device_index,
            samplerate=args.sample_rate,
            channels=args.channels,
            dtype="float32",
            callback=callback,
        ):
            reader.join()
    except Exception as exc:
        print(f"❌ audio_feeder failed: {exc}", flush=True)
        sys.exit(1)
    finally:
        running.clear()
        print("audio_feeder stopped.", flush=True)


if __name__ == "__main__":
    main()
