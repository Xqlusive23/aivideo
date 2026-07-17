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

1. Create a RunPod account, add a payment method.
2. **Pods → Deploy → GPU Pod.** Pick a GPU — an RTX 4090 or A10 is plenty
   for one real-time RVC stream; you don't need anything exotic. Roughly
   $0.20–0.50/hr depending on GPU choice and availability.
3. Under the pod's template settings, either:
   - Point it at this folder's `Dockerfile` (push this repo somewhere
     RunPod can build from, e.g. a GitHub repo + RunPod's GitHub integration), or
   - Use a base PyTorch template and manually `git clone`/`pip install` on
     first boot via the pod's terminal — slower to iterate but avoids
     setting up a build pipeline while you're still getting this working.
4. **Attach a persistent Volume** and mount it at `/models`. Upload your
   `.pth` voice model files there, one subfolder per voice:
   ```
   /models/
     grace/
       model.pth
       label.txt      <- contains: Grace
     marcus/
       model.pth
       label.txt      <- contains: Marcus
   ```
5. **Environment variables** on the pod:
   ```
   RTC_TICKET_SECRET=<same long random value you'll set in ledger-backend's .env>
   VOICE_MODELS_DIR=/models
   PORT=8000
   ```
6. **Expose port 8000** (RunPod gives you a public URL/port mapping for
   this — copy it down, you'll need it as `VITE_VOICE_RT_URL` in the
   frontend's `.env`).
7. Once running, sanity check: `https://<your-runpod-url>/health` should
   return `{"status": "ok", "voices": [...]}` listing whatever voice
   folders you uploaded.

## Performance tuning once it's actually running

`FRAME_MS` (40ms) and `CONTEXT_MS` (200ms) in `server.py` control the
real-time/quality tradeoff, and the right values depend on how fast your
specific GPU can run one inference pass — this needs measuring on real
hardware, not guessing:

- If frames start backing up (audio arrives faster than it can be
  converted, and delay grows over the course of a call), **raise
  `FRAME_MS`** — fewer, larger inference calls per second reduces
  per-call overhead at the cost of a bit more latency per frame.
- If quality suffers at frame boundaries (a warbling/choppy sound where
  each frame transitions), **raise `CONTEXT_MS`** — more surrounding
  audio per call improves continuity, again at some latency cost.
- Watch the pod's GPU utilization (`nvidia-smi` in the pod's terminal)
  while testing a live call — if it's pegged at 100%, you're at that
  GPU's ceiling for this workload; a bigger GPU or fewer concurrent calls
  per pod are the next levers, not smaller frame sizes.

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
