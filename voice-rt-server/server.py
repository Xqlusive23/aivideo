"""
voice-rt-server — continuous real-time voice conversion over WebSocket.

This is a genuinely different architecture from the ElevenLabs/fal.ai/Resemble
integrations built earlier in this project: those all send a COMPLETE audio
clip and wait for a COMPLETE converted clip back (a batch request/response,
regardless of how it's marketed). This server instead holds a live WebSocket
connection open for the whole call and processes small, continuous audio
frames as they arrive — no "record 1s, wait, play it back" cycle.

Deploy this on a RunPod GPU pod (see README.md in this folder). It is a
separate service from ledger-backend — ledger-backend still owns credits,
access tokens, and Paystack; this server ONLY does audio-in/audio-out voice
conversion, gated by a short-lived ticket that ledger-backend issues (see
the /api/voice/rtc-ticket endpoint added to server.js).

--------------------------------------------------------------------------
RVC inference: infer_rvc_python (MIT-licensed, R3gm)
--------------------------------------------------------------------------
convert_chunk() below uses infer_rvc_python's BaseLoader — confirmed from its
own README to support preloading multiple models (one per "tag") and running
inference by tag. Its documented, verified API is FILE-PATH based (you give
it an audio file path, it gives you back an output file path); its package
description also claims array input/output support, but I couldn't find a
confirmed method signature for that in its docs, so rather than guess at an
unverified call and hand you code that silently breaks, this writes each
small frame to a temp WAV file and reads the result back. For a frame this
size that's a trivial amount of disk I/O (sub-millisecond on any real disk,
effectively free on a tmpfs), and it's the version of this that's actually
guaranteed to run. If a genuine array-mode method turns up in a future
version of the library, swapping it in here removes that temp-file step
entirely — everything else in this file stays the same.
"""

import asyncio
import hashlib
import hmac
import json
import os
import tempfile
import time
from collections import deque

import numpy as np
import soundfile as sf
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Query
import uvicorn

# --- Config -------------------------------------------------------------------
# Must match the same value set in ledger-backend's .env (RTC_TICKET_SECRET).
# This is how this server verifies a ticket without needing its own copy of
# the access-token/credits database — ledger-backend is still the single
# source of truth for who's allowed to use the app at all.
RTC_TICKET_SECRET = os.environ.get("RTC_TICKET_SECRET", "")
if not RTC_TICKET_SECRET:
    raise RuntimeError("RTC_TICKET_SECRET is not set — this must match ledger-backend's .env")

SAMPLE_RATE = 16000          # RVC models are commonly trained/run at 16kHz or 40kHz — match your model
FRAME_MS = 40                # size of each audio frame processed per inference step
FRAME_SAMPLES = int(SAMPLE_RATE * FRAME_MS / 1000)

# How much trailing context (previously-seen audio) to feed the model
# alongside each new frame. Real-time voice conversion quality depends a lot
# on this — too little and it sounds choppy/discontinuous at frame
# boundaries, too much and latency grows. Tune this once it's running.
CONTEXT_MS = 200
CONTEXT_SAMPLES = int(SAMPLE_RATE * CONTEXT_MS / 1000)

VOICE_MODELS_DIR = os.environ.get("VOICE_MODELS_DIR", "/models")

app = FastAPI()


def verify_ticket(ticket: str) -> dict | None:
    """
    Tickets are minted by ledger-backend as: base64(payload_json) + "." + hmac_hex
    where payload_json = {"token": "<access token prefix>", "exp": <unix_ts>}.
    This just verifies the signature and expiry — it does NOT re-check
    credits/revocation live (that's ledger-backend's job at mint time); a
    short expiry (see server.js) keeps the window this matters small.
    """
    try:
        import base64
        payload_b64, signature = ticket.rsplit(".", 1)
        expected_sig = hmac.new(RTC_TICKET_SECRET.encode(), payload_b64.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected_sig, signature):
            return None
        payload = json.loads(base64.urlsafe_b64decode(payload_b64 + "=="))
        if payload.get("exp", 0) < time.time():
            return None
        return payload
    except Exception:
        return None


def load_voice_models():
    """
    Scans VOICE_MODELS_DIR and preloads each one into a shared BaseLoader
    instance (one "tag" per voice — see infer_rvc_python's README, this is
    its documented pattern for holding multiple models in memory at once).
    Expected layout:
        /models/<voice_id>/model.pth
        /models/<voice_id>/model.index   (optional, improves quality)
        /models/<voice_id>/label.txt     (display name shown in the app)
    Returns (converter, {voice_id: display_name}).
    """
    from infer_rvc_python import BaseLoader

    converter = BaseLoader(only_cpu=False, hubert_path=None, rmvpe_path=None)
    names = {}
    if not os.path.isdir(VOICE_MODELS_DIR):
        print(f"⚠️  VOICE_MODELS_DIR ({VOICE_MODELS_DIR}) doesn't exist — no voices loaded.")
        return converter, names

    for entry in os.listdir(VOICE_MODELS_DIR):
        voice_dir = os.path.join(VOICE_MODELS_DIR, entry)
        model_path = os.path.join(voice_dir, "model.pth")
        if not (os.path.isdir(voice_dir) and os.path.isfile(model_path)):
            continue
        index_path = os.path.join(voice_dir, "model.index")
        label_path = os.path.join(voice_dir, "label.txt")
        name = entry
        if os.path.isfile(label_path):
            with open(label_path) as f:
                name = f.read().strip() or entry

        try:
            converter.apply_conf(
                tag=entry,
                file_model=model_path,
                pitch_algo="rmvpe+",
                pitch_lvl=0,
                file_index=index_path if os.path.isfile(index_path) else "",
                index_influence=0.66 if os.path.isfile(index_path) else 0,
                respiration_median_filtering=3,
                envelope_ratio=0.25,
                consonant_breath_protection=0.33,
            )
            names[entry] = name
            print(f"✅ Loaded voice '{entry}' ({name})")
        except Exception as e:
            print(f"⚠️  Failed to load voice '{entry}': {e}")

    return converter, names


RVC_CONVERTER, VOICE_NAMES = load_voice_models()
VOICES = {vid: {"name": name} for vid, name in VOICE_NAMES.items()}


def convert_chunk(audio_np: np.ndarray, context_np: np.ndarray, voice_id: str) -> np.ndarray:
    """
    Converts one frame of audio into the target voice, using the surrounding
    context for continuity between frames (real-time RVC quality depends a
    lot on not treating each tiny frame as a totally isolated clip).

    Writes the (context + new frame) audio to a temp WAV, runs it through
    the preloaded model for this voice_id, reads the result back, and trims
    off the context portion — keeping only the part corresponding to the
    NEW audio this call was actually asked to convert.
    """
    full_input = np.concatenate([context_np, audio_np]).astype(np.float32)

    with tempfile.TemporaryDirectory() as tmp_dir:
        input_path = os.path.join(tmp_dir, "in.wav")
        sf.write(input_path, full_input, SAMPLE_RATE)

        result_paths = RVC_CONVERTER(
            input_path,
            voice_id,
            overwrite=True,
            parallel_workers=1,
        )
        if not result_paths:
            raise RuntimeError(f"RVC conversion returned no output for voice '{voice_id}'")

        converted_full, converted_sr = sf.read(result_paths[0], dtype="float32")

    # If the model's output sample rate differs from SAMPLE_RATE, resample
    # so the trailing-trim math below (and the WebSocket frame size the
    # frontend expects) stays correct.
    if converted_sr != SAMPLE_RATE:
        target_len = int(len(converted_full) * SAMPLE_RATE / converted_sr)
        converted_full = np.interp(
            np.linspace(0, len(converted_full) - 1, target_len),
            np.arange(len(converted_full)),
            converted_full,
        ).astype(np.float32)

    new_len = len(audio_np)
    if len(converted_full) < new_len:
        # Shouldn't normally happen, but pad rather than crash if the model
        # ever returns something shorter than expected.
        converted_full = np.pad(converted_full, (0, new_len - len(converted_full)))
    return converted_full[-new_len:]


class CallSession:
    """Holds the rolling audio buffer and state for one active WebSocket connection."""

    def __init__(self, voice_id: str):
        self.voice_id = voice_id
        # Rolling buffer of recent audio, used as "context" for the next frame.
        self.history = deque(maxlen=CONTEXT_SAMPLES)
        self.history.extend(np.zeros(CONTEXT_SAMPLES, dtype=np.float32))

    def process_frame(self, frame: np.ndarray) -> np.ndarray:
        context = np.array(self.history, dtype=np.float32)
        converted = convert_chunk(frame, context, self.voice_id)
        self.history.extend(frame)
        return converted


@app.get("/health")
async def health():
    return {"status": "ok", "voices": list(VOICES.keys())}


@app.get("/voices")
async def voices(ticket: str = Query(...)):
    payload = verify_ticket(ticket)
    if not payload:
        return {"error": "Invalid or expired ticket"}, 401
    return {"voices": [{"voice_id": vid, "name": v["name"]} for vid, v in VOICES.items()]}


@app.websocket("/convert")
async def convert_ws(websocket: WebSocket, ticket: str = Query(...), voice_id: str = Query(...)):
    payload = verify_ticket(ticket)
    if not payload:
        await websocket.close(code=4001, reason="Invalid or expired ticket")
        return
    if voice_id not in VOICES:
        await websocket.close(code=4004, reason=f"Unknown voice_id: {voice_id}")
        return

    await websocket.accept()
    session = CallSession(voice_id)

    try:
        while True:
            # Frontend sends raw PCM16 little-endian bytes, FRAME_SAMPLES per message.
            data = await websocket.receive_bytes()
            frame_int16 = np.frombuffer(data, dtype=np.int16)
            frame_float = frame_int16.astype(np.float32) / 32768.0

            try:
                converted_float = await asyncio.to_thread(session.process_frame, frame_float)
            except Exception as e:
                # Surface the error rather than silently dropping the frame —
                # easier to debug a bad model file / OOM / etc. this way than
                # having it just look like dead air on the frontend.
                print(f"⚠️  Conversion error for voice '{voice_id}': {e}")
                await websocket.send_text(json.dumps({"error": str(e)}))
                continue

            converted_int16 = np.clip(converted_float * 32768.0, -32768, 32767).astype(np.int16)
            await websocket.send_bytes(converted_int16.tobytes())
    except WebSocketDisconnect:
        pass


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)