# voice-rt-server — real-time voice conversion for InspireTech

A separate service from `ledger-backend`. This one thing: converts a live
mic stream into a chosen voice continuously, over a WebSocket, for as long
as a call lasts. It does NOT know about credits, access tokens, or
Paystack — `ledger-backend` remains the single source of truth for who's
allowed to use the app; this server just checks a short-lived **ticket**
that `ledger-backend` mints on request.

## Why this exists (vs. the ElevenLabs/fal.ai/Resemble integrations)

Every hosted voice-conversion API we looked at (ElevenLabs' Voice Changer,
Resemble's documented Speech-to-Speech, fal.ai's hosted Chatterbox) works
the same way: send a **complete** audio clip, wait, get a **complete**
converted clip back. That's fine for turning a recording into a different
voice, but it's fundamentally the wrong shape for a live call — there's
always at least "one chunk's worth" of built-in delay, no matter how small
you make the chunks.

This server instead holds one WebSocket connection open per active call and
processes small, continuous frames of audio as they arrive — much closer to
how a phone call actually works.

## What you still need to do

1. **Get RVC voice models.** Many are freely shared by the RVC community
   (search "RVC model" + a character/voice name — Hugging Face and
   community model-sharing sites host a lot of these). Each voice needs its
   own trained `.pth` file, optionally paired with a `.index` file for
   better quality. This is the tradeoff for using RVC instead of a
   zero-shot model: you're building a curated voice library, not offering
   "any voice from a sample."
2. **Upload them to the pod's `/models` volume** in the layout below — the
   server auto-discovers and preloads every voice folder it finds on boot.
3. That's it — `convert_chunk()` is a real implementation (using the
   MIT-licensed `infer_rvc_python` library), not a stub. If you want to
   swap in a different RVC library later, or if `infer_rvc_python` adds a
   genuine array-input/output mode in a future version (its current docs
   describe only a file-path based API, which is what `convert_chunk()`
   uses today via small temp WAV files), that's the one function to revisit.

## Deploying on RunPod

You already have a GPU pod — this section covers wiring **voice-rt-server** onto it.

### Pod settings checklist

| Setting | Value |
|---------|--------|
| HTTP ports | **8000** (required), optionally 8888, 6006 |
| Volume mount | `/models` (persistent — store RVC `.pth` files here) |
| `RTC_TICKET_SECRET` | Same as `ledger-backend/.env` — full string, not truncated |
| `VOICE_MODELS_DIR` | `/models` |
| `PORT` | `8000` |

Voice model layout on the volume:

```
/models/
  grace/
    model.pth
    label.txt      <- contains: Grace
    pitch.txt      <- optional semitone shift (e.g. 3–4 for natural female lift)
    preview.wav    <- optional ready-made preview clip (instant ▶ Preview)
    preview_in.wav <- optional neutral phrase; server converts it for preview
  ronald/
    model.pth
    label.txt
    pitch.txt      <- e.g. -2 for slightly deeper male
  _shared/
    preview_in.wav <- shared neutral phrase for all voices without their own
```

**Female models:** grace and queen default to **+4 semitones** in `server.py` (natural lift — higher values like +8 sound robotic). Override with `pitch.txt` on the pod (e.g. `echo 3 > /models/grace/pitch.txt`). Restart `server.py` after editing. Remove old `pitch.txt` if you set it to 6–8 earlier.

**▶ Preview in the app:** upload either `preview.wav` (already converted) or `preview_in.wav` (a 2–4s WAV of someone saying a short phrase at 16kHz mono). The app calls `/preview` on first play (cached on the pod).

Public URL (RunPod → Connect): `https://YOUR-POD-ID-8000.proxy.runpod.net`

### Start the server (generic PyTorch pod)

If your pod uses a stock PyTorch image (e.g. `vishwa123/cuda-*-runpod`), nothing listens on port 8000 until you install and run `server.py`.

**Option A — one-time setup in Web Terminal** (fastest):

```bash
git clone --depth 1 https://github.com/Xqlusive23/aivideo.git /workspace/aivideo
bash /workspace/aivideo/voice-rt-server/runpod.setup.sh
```

If `runpod.setup.sh` is not in the repo yet, run the install manually:

```bash
git clone --depth 1 https://github.com/Xqlusive23/aivideo.git /workspace/aivideo
cd /workspace/aivideo/voice-rt-server
pip install --no-cache-dir -r requirements.txt
nohup python server.py >>/workspace/voice-rt-server.log 2>&1 &
sleep 3 && curl -s http://127.0.0.1:8000/health
```

**Option B — custom Docker image** (survives restarts):

Build from `Dockerfile.txt` in this folder, push to Docker Hub, set as pod container image. Env vars and `/models` volume stay the same.

### Verify

```bash
curl https://YOUR-POD-ID-8000.proxy.runpod.net/health
```

Should return `{"status": "ok", "voices": [...]}`. Then wire InspireTech: **`wire-production.md`**.

### Port 8000 stuck on "Initializing" / "Waiting for service to respond"

RunPod shows that page until **something responds on port 8000 inside the pod**.
Common causes:

| Cause | Fix |
|-------|-----|
| `server.py` never started | Run the install commands below in Web Terminal |
| `RTC_TICKET_SECRET` missing in shell | `export RTC_TICKET_SECRET='...'` before starting (must match ledger) |
| `pip install` still running or failed | Wait, or run `bash install-deps.sh` and watch errors |
| Real-time connects but every frame errors `weights_only` / `fairseq` | Restart server with latest `server.py` (patches `torch.load` for RVC) |
| `torch.cuda.is_available()` False but `nvidia-smi` shows GPU | Reinstall PyTorch cu124 (cu130 often hits CUDA error 804 on RunPod) — see below |
| RVC `returned no output` on CPU | Use `pitch_algo=pm` not `rmvpe+`; fix CUDA for real-time |
| Every frame: `No such file or directory: 'ffmpeg'` | `apt-get update && apt-get install -y ffmpeg` then restart server |
| Old server loaded all RVC models before opening port | Pull latest `server.py` — `/health` now responds immediately |

**Diagnose on the pod:**

```bash
export RTC_TICKET_SECRET='YOUR_FULL_SECRET_FROM_LEDGER'
export VOICE_MODELS_DIR=/models
export PORT=8000
bash /workspace/aivideo/voice-rt-server/runpod.diagnose.sh
```

**Start in foreground first** (so you see the real error):

```bash
git clone --depth 1 https://github.com/Xqlusive23/aivideo.git /workspace/aivideo
cd /workspace/aivideo/voice-rt-server
bash install-deps.sh
export RTC_TICKET_SECRET='6c6a64096b6458096b645d2af3079a916b3c7b714583d29c'
export VOICE_MODELS_DIR=/models
export PORT=8000
python server.py
```

Do **not** use plain `pip install -r requirements.txt` on RunPod — `fairseq` fails on pip 24+.
Use `bash install-deps.sh` instead.

If `install-deps.sh` is not in the cloned repo yet, run this manually:

```bash
pip install --no-cache-dir fastapi==0.115.0 "uvicorn[standard]==0.32.0" numpy==1.26.4 websockets==13.1 soundfile==0.12.1
pip install --no-cache-dir "https://github.com/One-sixth/fairseq/archive/main.zip"
pip install --no-cache-dir infer-rvc-python==1.2.0 --no-deps
pip install --no-cache-dir praat-parselmouth pyworld==0.3.2 faiss-cpu==1.7.3 torchcrepe==0.0.20 ffmpeg-python typeguard==4.2.0 librosa gradio
python -c "import soundfile; from infer_rvc_python import BaseLoader; print('OK')"
```

You should see `Uvicorn running on http://0.0.0.0:8000`. Leave that running, or Ctrl+C and use `nohup python server.py >>/workspace/voice-rt-server.log 2>&1 &`.

### GPU visible in nvidia-smi but PyTorch says cuda False

Common on generic RunPod images (`torch 2.9.0+cu130` + error 804). Fix:

```bash
pip uninstall -y torch torchaudio torchvision
pip install torch==2.4.0 torchaudio==2.4.0 --index-url https://download.pytorch.org/whl/cu124
python -c "import torch; print(torch.__version__, torch.cuda.is_available(), torch.cuda.get_device_name(0))"
```

Must print `True` and `NVIDIA GeForce RTX 4090`. Then restart `python server.py` — log should show **`RVC on GPU`**.

Windows helper to update all local env files:

```powershell
.\scripts\wire-voice-rt.ps1 -Url "https://YOUR-POD-ID-8000.proxy.runpod.net"
```

### Full deploy from scratch

1. Create a RunPod account, add a payment method.
2. **Pods → Deploy → GPU Pod.** RTX 3090/4090 or A10 is plenty for one live stream (~$0.22–0.50/hr).
3. Use Option A or B above to run `voice-rt-server`.
4. Attach a persistent volume at `/models` and upload voice folders.
5. Set environment variables (see `runpod.env.example`).
6. Expose port **8000** and copy the proxy URL into `VOICE_RT_URL` / `VITE_VOICE_RT_URL`.

## Performance tuning once it's actually running

`FRAME_MS` (default **400ms**) and `CONTEXT_MS` (default **100ms**) control the
latency/quality tradeoff. End-to-end delay is roughly **frame size + inference
time + network** (~0.7–1.2s with `pm` on a 4090). The server skips stale frames
while the GPU is busy so delay does not snowball to 2s+.

| Symptom | Fix |
|---------|-----|
| ~2s delay / laggy voice | Lower `FRAME_MS` (try 400), ensure `RVC_PITCH_ALGO=pm`, restart server + reload app |
| Pulsing / wavy audio | Raise `FRAME_MS` (try 600–800) |
| `Frame size mismatch` in logs | Reload app — frontend syncs `frame_samples` from `/voices` |
| Warbling at chunk boundaries | Raise `CONTEXT_MS` (e.g. 200) |
| GPU at 100% in `nvidia-smi` | Fewer concurrent calls or bigger GPU |

On the pod:

```bash
export RVC_PITCH_ALGO=pm
export FRAME_MS=400
export CONTEXT_MS=100
python server.py
# Startup line should show: voice-rt-server: 400ms frames (6400 samples ...
```

Watch GPU utilization (`nvidia-smi`) while testing a live call.

## Testing it directly (before wiring up a real call)

Once deployed with at least one voice model uploaded, confirm the whole
pipeline works before testing through InspireTech's UI:
```
curl https://<your-runpod-url>/health
```
Should return `{"status": "ok", "voices": ["<your voice folder names>"]}`.
If a voice you uploaded doesn't show up here, check the pod's logs on boot
for a `⚠️  Failed to load voice` line — that'll show the actual loading
error (bad checkpoint file, missing index, etc.) rather than it just
silently not appearing.

## Cost reality check

A persistent pod runs (and bills) continuously, whether or not anyone's
using it — unlike the pay-per-use APIs we integrated earlier. At $0.30/hr
that's roughly $216/month running 24/7. Options as you scale:
- Stop the pod when you're not actively testing/using it (manual, free
  when stopped, but means "always available" isn't actually true yet).
- Once you have real paying usage patterns, look at RunPod's autoscaling
  or a scheduled start/stop matching your actual usage hours.
