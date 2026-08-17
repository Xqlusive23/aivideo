"""
virtualcam_feeder.py — receives raw RGBA video frames from Electron's main
process (main.js) over stdin, and pushes each one into a real system
virtual camera device via pyvirtualcam's Unity Capture backend.

This is the actual piece that makes "InspireTech Camera" show up in Zoom's/
Telegram's/Discord's camera dropdown — Unity Capture registers a real
DirectShow virtual camera device on Windows; this script is just the thing
feeding it frames, frame by frame, for as long as it keeps running.

Protocol read from stdin (matches what main.js writes):
    [4 bytes: big-endian uint32 frame byte length] [that many raw RGBA bytes]
repeated for as long as frames keep arriving.

One-time setup needed before this will do anything (see README.md):
    1. Install Unity Capture's driver (schellingb/UnityCapture on GitHub).
    2. pip install pyvirtualcam numpy

Unity Capture's native idle buffer is yellowish. We send an opaque black
frame immediately, then keep sending on the same thread that opened the
camera (DirectShow/shared-memory updates fail if send() is called from a
worker thread — calling apps then stay on a blank/black picture).
"""

import argparse
import struct
import sys
import threading

import numpy as np
import pyvirtualcam

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")


def read_exact(stream, n):
    """Reads exactly n bytes, looping as needed — a single stream.read(n)
    call isn't guaranteed to return all n bytes at once on every platform."""
    buf = b""
    while len(buf) < n:
        chunk = stream.read(n - len(buf))
        if not chunk:
            return None  # stdin closed / Electron process ended
        buf += chunk
    return buf


def make_idle_frame(width, height):
    """Opaque black RGBA — overrides Unity Capture's yellowish default buffer."""
    frame = np.zeros((height, width, 4), dtype=np.uint8)
    frame[:, :, 3] = 255
    return frame


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--width", type=int, required=True)
    parser.add_argument("--height", type=int, required=True)
    parser.add_argument("--fps", type=int, required=True)
    parser.add_argument(
        "--device",
        default="InspireTech Camera",
        help="Registered Unity Capture device name (default: InspireTech Camera)",
    )
    args = parser.parse_args()

    print(
        f"Starting virtual camera {args.width}x{args.height}@{args.fps} "
        f"as '{args.device}' (Unity Capture)...",
        flush=True,
    )

    frame_size = args.width * args.height * 4  # RGBA = 4 bytes/pixel
    latest_lock = threading.Lock()
    latest_frame = make_idle_frame(args.width, args.height)
    stop_reader = threading.Event()

    def stdin_loop():
        nonlocal latest_frame
        stdin = sys.stdin.buffer
        try:
            while not stop_reader.is_set():
                header = read_exact(stdin, 4)
                if header is None:
                    print("stdin closed — stopping.", flush=True)
                    break
                (length,) = struct.unpack(">I", header)

                payload = read_exact(stdin, length)
                if payload is None:
                    print("stdin closed mid-frame — stopping.", flush=True)
                    break

                if length != frame_size:
                    # Renderer sent a frame at a different resolution than
                    # expected — skip it rather than crash the whole feeder.
                    print(
                        f"⚠️  Got {length} bytes, expected {frame_size} — skipping frame.",
                        flush=True,
                    )
                    continue

                frame = np.frombuffer(payload, dtype=np.uint8).reshape(
                    (args.height, args.width, 4)
                ).copy()
                frame[:, :, 3] = 255
                with latest_lock:
                    latest_frame = frame
        finally:
            stop_reader.set()

    reader = threading.Thread(target=stdin_loop, name="virtualcam-stdin", daemon=True)
    reader.start()

    with pyvirtualcam.Camera(
        width=args.width,
        height=args.height,
        fps=args.fps,
        fmt=pyvirtualcam.PixelFormat.RGBA,  # Unity Capture specifically supports RGBA (most backends don't)
        backend="unitycapture",
        device=args.device,
    ) as cam:
        print(f"✅ Virtual camera active as: {cam.device}", flush=True)
        print("Zoom/Telegram/Discord should now be able to select this as a camera.", flush=True)

        # First send MUST happen on this thread so DirectShow clients see a
        # real buffer instead of Unity's yellow unused memory.
        cam.send(latest_frame)

        while not stop_reader.is_set():
            with latest_lock:
                frame = latest_frame
            try:
                cam.send(frame)
                cam.sleep_until_next_frame()
            except Exception as err:
                print(f"sender stopped: {err}", flush=True)
                break

    stop_reader.set()
    reader.join(timeout=2.0)


if __name__ == "__main__":
    main()
