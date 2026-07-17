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
"""

import sys
sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')
import argparse
import struct
import sys

import numpy as np
import pyvirtualcam


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

        frame_size = args.width * args.height * 4  # RGBA = 4 bytes/pixel
        stdin = sys.stdin.buffer

        while True:
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
                print(f"⚠️  Got {length} bytes, expected {frame_size} — skipping frame.", flush=True)
                continue

            frame = np.frombuffer(payload, dtype=np.uint8).reshape((args.height, args.width, 4))
            cam.send(frame)
            cam.sleep_until_next_frame()


if __name__ == "__main__":
    main()
