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
import contextlib
import hashlib
import hmac
import json
import os
import tempfile
import time
from collections import deque

import numpy as np
import soundfile as sf
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect, Query
from fastapi.responses import Response
import uvicorn


def _patch_torch_for_rvc_checkpoints() -> None:
    """
    PyTorch 2.6+ defaults torch.load(..., weights_only=True). RVC .pth checkpoints
    embed fairseq pickle objects and fail unless weights_only=False (trusted models).
    Must run before infer_rvc_python imports torch.load.
    """
    import torch

    try:
        from fairseq.data.dictionary import Dictionary

        if hasattr(torch.serialization, "add_safe_globals"):
            torch.serialization.add_safe_globals([Dictionary])
    except Exception:
        pass

    if getattr(torch.load, "_rvc_patched", False):
        return

    _orig_load = torch.load

    def _load(*args, **kwargs):
        if "weights_only" not in kwargs:
            kwargs["weights_only"] = False
        return _orig_load(*args, **kwargs)

    _load._rvc_patched = True  # type: ignore[attr-defined]
    torch.load = _load  # type: ignore[assignment]


_patch_torch_for_rvc_checkpoints()

# --- Config -------------------------------------------------------------------
# Must match the same value set in ledger-backend's .env (RTC_TICKET_SECRET).
# This is how this server verifies a ticket without needing its own copy of
# the access-token/credits database — ledger-backend is still the single
# source of truth for who's allowed to use the app at all.
RTC_TICKET_SECRET = os.environ.get("RTC_TICKET_SECRET", "")
if not RTC_TICKET_SECRET:
    raise RuntimeError("RTC_TICKET_SECRET is not set — this must match ledger-backend's .env")

SAMPLE_RATE = 16000          # RVC models are commonly trained/run at 16kHz or 40kHz — match your model
# Frame size vs latency tradeoff. infer_rvc_python file-path infer is ~0.25–0.5s
# with pm on a 4090; 400ms frames ≈ ~0.7–1s end-to-end. Raise to 600–800 if audio
# pulses; lower to 300 if GPU keeps up and you want less delay.
FRAME_MS = int(os.environ.get("FRAME_MS", "400"))
FRAME_SAMPLES = int(SAMPLE_RATE * FRAME_MS / 1000)

# How much trailing context (previously-seen audio) to feed the model
# alongside each new frame. Real-time voice conversion quality depends a lot
# on this — too little and it sounds choppy/discontinuous at frame
# boundaries, too much and latency grows. Tune this once it's running.
CONTEXT_MS = int(os.environ.get("CONTEXT_MS", "100"))
CONTEXT_SAMPLES = int(SAMPLE_RATE * CONTEXT_MS / 1000)

# infer_rvc_python's file-path API needs a minimum clip length; shorter WAVs
# often return empty output silently.
MIN_RVC_MS = int(os.environ.get("MIN_RVC_MS", "500"))
MIN_RVC_SAMPLES = int(SAMPLE_RATE * MIN_RVC_MS / 1000)

VOICE_MODELS_DIR = os.environ.get("VOICE_MODELS_DIR", "/models")

app = FastAPI()

# Loaded lazily so uvicorn binds port 8000 immediately (RunPod proxy stops
# showing "initializing" even while RVC models are still loading).
RVC_CONVERTER = None
VOICES: dict[str, dict[str, str]] = {}
_models_load_error: str | None = None
_models_loading = False
_models_lock = asyncio.Lock()
_PREVIEW_CACHE: dict[str, bytes] = {}


DEFAULT_PITCH_BY_VOICE: dict[str, int] = {
    "grace": 4,
    "queen": 4,
}


def read_pitch_lvl(voice_dir: str, voice_id: str) -> int:
    """Optional /models/<voice>/pitch.txt — semitone shift (e.g. 4 for slightly higher female)."""
    pitch_path = os.path.join(voice_dir, "pitch.txt")
    if os.path.isfile(pitch_path):
        try:
            return int(open(pitch_path).read().strip())
        except ValueError:
            pass
    return DEFAULT_PITCH_BY_VOICE.get(voice_id, 0)


def voice_has_preview(voice_dir: str) -> bool:
    if os.path.isfile(os.path.join(voice_dir, "preview.wav")):
        return True
    for rel in ("preview_in.wav",):
        if os.path.isfile(os.path.join(voice_dir, rel)):
            return True
    shared = os.path.join(VOICE_MODELS_DIR, "_shared", "preview_in.wav")
    bundled = os.path.join(os.path.dirname(__file__), "assets", "preview_in.wav")
    return os.path.isfile(shared) or os.path.isfile(bundled)


def render_preview_wav(voice_id: str) -> bytes:
    """Return WAV bytes for a voice preview (cached after first generation)."""
    if voice_id in _PREVIEW_CACHE:
        return _PREVIEW_CACHE[voice_id]
    if RVC_CONVERTER is None:
        raise RuntimeError("Models not loaded")

    voice_dir = os.path.join(VOICE_MODELS_DIR, voice_id)
    static_preview = os.path.join(voice_dir, "preview.wav")
    if os.path.isfile(static_preview):
        data = open(static_preview, "rb").read()
        _PREVIEW_CACHE[voice_id] = data
        return data

    source_path = None
    for candidate in (
        os.path.join(voice_dir, "preview_in.wav"),
        os.path.join(VOICE_MODELS_DIR, "_shared", "preview_in.wav"),
        os.path.join(os.path.dirname(__file__), "assets", "preview_in.wav"),
    ):
        if os.path.isfile(candidate):
            source_path = candidate
            break

    if not source_path:
        raise FileNotFoundError(
            f"No preview for '{voice_id}'. Add /models/{voice_id}/preview.wav "
            f"(a short clip of that voice), or preview_in.wav (neutral phrase to convert), "
            f"or /models/_shared/preview_in.wav shared by all voices."
        )

    result_paths = RVC_CONVERTER(source_path, voice_id, overwrite=True, parallel_workers=1)
    if not result_paths:
        raise RuntimeError(f"Preview conversion returned no output for '{voice_id}'")
    with open(result_paths[0], "rb") as f:
        data = f.read()
    _PREVIEW_CACHE[voice_id] = data
    return data


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
        /models/<voice_id>/pitch.txt     (optional semitone shift, e.g. 6 for female)
        /models/<voice_id>/preview.wav   (optional ready-made preview clip)
        /models/<voice_id>/preview_in.wav (optional neutral phrase → converted for /preview)
    Returns (converter, {voice_id: metadata dict}).
    """
    import torch
    from infer_rvc_python import BaseLoader

    use_cuda = torch.cuda.is_available()
    only_cpu = not use_cuda
    # pm is much faster than rmvpe+ for live file-path infer (~1s/frame → ~0.3s).
    # Set RVC_PITCH_ALGO=rmvpe+ for quality in offline/batch use only.
    pitch_algo = os.environ.get("RVC_PITCH_ALGO") or "pm"
    if os.environ.get("RVC_ONLY_CPU", "").lower() in ("1", "true", "yes"):
        only_cpu = True
        pitch_algo = os.environ.get("RVC_PITCH_ALGO") or "pm"

    if only_cpu:
        print(f"⚠️  RVC on CPU with pitch_algo={pitch_algo} (slow — enable CUDA on the pod for real-time)")
    else:
        print(f"✅ RVC on GPU ({torch.cuda.get_device_name(0)}), pitch_algo={pitch_algo}")

    converter = BaseLoader(only_cpu=only_cpu, hubert_path=None, rmvpe_path=None)
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

        pitch_lvl = read_pitch_lvl(voice_dir, entry)
        try:
            converter.apply_conf(
                tag=entry,
                file_model=model_path,
                pitch_algo=pitch_algo,
                pitch_lvl=pitch_lvl,
                file_index=index_path if os.path.isfile(index_path) else "",
                index_influence=0.66 if os.path.isfile(index_path) else 0,
                respiration_median_filtering=3,
                envelope_ratio=0.25,
                consonant_breath_protection=0.33,
            )
            names[entry] = {
                "name": name,
                "pitch_lvl": pitch_lvl,
                "has_preview": voice_has_preview(voice_dir),
            }
            pitch_note = f", pitch_lvl={pitch_lvl}" if pitch_lvl else ""
            print(f"✅ Loaded voice '{entry}' ({name}{pitch_note})")
        except Exception as e:
            print(f"⚠️  Failed to load voice '{entry}': {e}")

    return converter, names


async def ensure_models_loaded() -> None:
    """Load RVC models once, on first use. Keeps /health fast for RunPod probes."""
    global RVC_CONVERTER, VOICES, _models_load_error, _models_loading
    if RVC_CONVERTER is not None or _models_load_error is not None:
        return
    async with _models_lock:
        if RVC_CONVERTER is not None or _models_load_error is not None:
            return
        _models_loading = True
        try:
            converter, names = await asyncio.to_thread(load_voice_models)
            RVC_CONVERTER = converter
            VOICES = names
            print(f"✅ Models ready: {list(VOICES.keys()) or '(none — add folders under VOICE_MODELS_DIR)'}")
        except Exception as e:
            _models_load_error = str(e)
            print(f"⚠️  Failed to load voice models: {e}")
        finally:
            _models_loading = False


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
    if len(full_input) < MIN_RVC_SAMPLES:
        full_input = np.pad(full_input, (0, MIN_RVC_SAMPLES - len(full_input)))

    # Boost quiet mic input — RVC often returns near-silence unless speech is clearly above noise.
    peak = float(np.max(np.abs(full_input)))
    if peak > 1e-5:
        full_input = full_input * min(4.0, 0.85 / peak)

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
            raise RuntimeError(
                f"RVC conversion returned no output for voice '{voice_id}' "
                f"(input {len(full_input) / SAMPLE_RATE:.2f}s — check pitch_algo/GPU on the pod)"
            )

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


def frame_looks_like_speech(frame: np.ndarray) -> bool:
    """Skip fan/room noise — RVC turns non-speech into ghost voice if we infer anyway."""
    rms = float(np.sqrt(np.mean(frame * frame)))
    if rms < 0.004:
        return False
    spectrum = np.abs(np.fft.rfft(frame))
    freqs = np.fft.rfftfreq(len(frame), 1.0 / SAMPLE_RATE)
    total = float(np.sum(spectrum**2)) + 1e-12
    speech_band = (freqs >= 280) & (freqs <= 3500)
    speech_ratio = float(np.sum(spectrum[speech_band] ** 2)) / total
    return speech_ratio >= 0.30 and rms >= 0.005


class CallSession:
    """Holds the rolling audio buffer and state for one active WebSocket connection."""

    def __init__(self, voice_id: str):
        self.voice_id = voice_id
        # Rolling buffer of recent audio, used as "context" for the next frame.
        self.history = deque(maxlen=CONTEXT_SAMPLES)
        self.history.extend(np.zeros(CONTEXT_SAMPLES, dtype=np.float32))

    def process_frame(self, frame: np.ndarray) -> np.ndarray:
        if not frame_looks_like_speech(frame):
            return np.zeros_like(frame)
        context = np.array(self.history, dtype=np.float32)
        converted = convert_chunk(frame, context, self.voice_id)
        self.history.extend(frame)
        return converted


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "voices": list(VOICES.keys()),
        "models_loaded": RVC_CONVERTER is not None,
        "models_loading": _models_loading,
        "models_error": _models_load_error,
        "frame_ms": FRAME_MS,
        "frame_samples": FRAME_SAMPLES,
    }


@app.get("/voices")
async def voices(ticket: str = Query(...)):
    payload = verify_ticket(ticket)
    if not payload:
        return {"error": "Invalid or expired ticket"}, 401
    await ensure_models_loaded()
    if _models_load_error:
        return {"error": f"Voice models failed to load: {_models_load_error}"}, 503
    return {
        "voices": [
            {
                "voice_id": vid,
                "name": v["name"],
                "pitch_lvl": v.get("pitch_lvl", 0),
                "has_preview": v.get("has_preview", False),
            }
            for vid, v in VOICES.items()
        ],
        "frame_ms": FRAME_MS,
        "frame_samples": FRAME_SAMPLES,
    }


@app.get("/preview")
async def preview(voice_id: str = Query(...), ticket: str = Query(...)):
    payload = verify_ticket(ticket)
    if not payload:
        raise HTTPException(status_code=401, detail="Invalid or expired ticket")
    await ensure_models_loaded()
    if _models_load_error:
        raise HTTPException(status_code=503, detail=f"Voice models failed to load: {_models_load_error}")
    if voice_id not in VOICES:
        raise HTTPException(status_code=404, detail=f"Unknown voice_id: {voice_id}")
    try:
        wav_bytes = await asyncio.to_thread(render_preview_wav, voice_id)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e
    return Response(content=wav_bytes, media_type="audio/wav")


@app.websocket("/convert")
async def convert_ws(websocket: WebSocket, ticket: str = Query(...), voice_id: str = Query(...)):
    payload = verify_ticket(ticket)
    if not payload:
        await websocket.close(code=4001, reason="Invalid or expired ticket")
        return

    await ensure_models_loaded()
    if _models_load_error or RVC_CONVERTER is None:
        await websocket.close(code=1011, reason=f"Models not ready: {_models_load_error or 'still loading'}")
        return
    if voice_id not in VOICES:
        await websocket.close(code=4004, reason=f"Unknown voice_id: {voice_id}")
        return

    await websocket.accept()
    session = CallSession(voice_id)

    pending_frame: np.ndarray | None = None
    infer_ready = asyncio.Event()
    closed = False

    async def infer_loop() -> None:
        """Process frames one at a time; skip stale frames while GPU is busy (lower latency)."""
        nonlocal pending_frame
        while not closed:
            await infer_ready.wait()
            infer_ready.clear()
            while not closed:
                frame = pending_frame
                pending_frame = None
                if frame is None:
                    break
                try:
                    converted_float = await asyncio.to_thread(session.process_frame, frame)
                    converted_int16 = np.clip(converted_float * 32768.0, -32768, 32767).astype(np.int16)
                    await websocket.send_bytes(converted_int16.tobytes())
                except Exception as e:
                    print(f"⚠️  Conversion error for voice '{voice_id}': {e}")
                    try:
                        await websocket.send_text(json.dumps({"error": str(e)}))
                    except Exception:
                        pass
                # A newer mic frame arrived during inference — drop the stale gap and convert latest.
                if pending_frame is None:
                    break

    worker = asyncio.create_task(infer_loop())

    try:
        while True:
            # Frontend sends raw PCM16 little-endian bytes, FRAME_SAMPLES per message.
            data = await websocket.receive_bytes()
            frame_int16 = np.frombuffer(data, dtype=np.int16)
            if len(frame_int16) != FRAME_SAMPLES:
                print(
                    f"⚠️  Frame size mismatch: got {len(frame_int16)} samples, "
                    f"expected {FRAME_SAMPLES} ({FRAME_MS}ms) — update frontend VOICE_RT_FRAME_SAMPLES"
                )
                continue
            pending_frame = frame_int16.astype(np.float32) / 32768.0
            infer_ready.set()
    except WebSocketDisconnect:
        pass
    finally:
        closed = True
        infer_ready.set()
        worker.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await worker


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8000))
    print(
        f"voice-rt-server: {FRAME_MS}ms frames ({FRAME_SAMPLES} samples @ {SAMPLE_RATE}Hz), "
        f"{CONTEXT_MS}ms context, RVC_PITCH_ALGO={os.environ.get('RVC_PITCH_ALGO') or 'pm (default)'}"
    )
    uvicorn.run(app, host="0.0.0.0", port=port)