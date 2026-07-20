# Wire voice-rt-server (RunPod) to InspireTech

Use after `/health` returns `{"status":"ok","voices":[...]}` on your RunPod URL.

Your RunPod HTTPS URL format:

```
https://YOUR-POD-ID-8000.proxy.runpod.net
```

No trailing slash. Copy it from **RunPod → Pods → Connect → HTTP port 8000**.

---

## Step 1 — Confirm RunPod is serving

From your PC:

```powershell
curl.exe "https://YOUR-POD-ID-8000.proxy.runpod.net/health"
```

Expected: `{"status":"ok","voices":["..."]}`

If **404**: `voice-rt-server` is not running — run `bash runpod.setup.sh` on the pod (see README).

---

## Step 2 — Pod env vars (must match ledger)

RunPod → Edit Pod → Environment Variables:

```
RTC_TICKET_SECRET=<exact value from ledger-backend/.env>
VOICE_MODELS_DIR=/models
PORT=8000
```

Expose HTTP ports: **8000** (plus 8888/6006 if you use Jupyter).

Mount network volume at **`/models`** with RVC voice folders.

---

## Step 3 — Update local env files

From repo root:

```powershell
.\scripts\wire-voice-rt.ps1 -Url "https://YOUR-POD-ID-8000.proxy.runpod.net"
```

Restart local dev: `npm run dev` and `cd ledger-backend && npm start`.

---

## Step 4 — Railway (production ledger)

1. [Railway dashboard](https://railway.app) → ledger service → **Variables**
2. Set `VOICE_RT_URL` = same RunPod URL
3. Confirm `RTC_TICKET_SECRET` matches the pod
4. Redeploy happens automatically

Verify:

```powershell
curl.exe "https://aivideo-production-db98.up.railway.app/api/voice/rtc-voices" -H "Authorization: Bearer YOUR_TOKEN"
```

---

## Step 5 — Vercel (production website)

Update `.env.production`, then:

```bash
npm run build
mkdir -p .vercel/output/static
cp -r dist/* .vercel/output/static/
npx vercel deploy --prebuilt --prod --yes
```

Test: https://www.inspirestream.xyz/#/app → Voice → **Real-time**.

---

## When you restart the pod

RunPod proxy URLs usually stay the same for the same pod ID. If you **delete and recreate** the pod, the URL changes — repeat Steps 3–5.

After every pod start, re-run `bash runpod.setup.sh` unless you baked the server into a custom Docker image or set a persistent start command.

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `/health` → 404 | Run `runpod.setup.sh` on pod; confirm port 8000 exposed |
| 502 from ledger | Wrong `VOICE_RT_URL` or pod stopped |
| Ticket rejected | `RTC_TICKET_SECRET` mismatch — re-paste full secret on pod |
| Empty voices | Upload `.pth` models to `/models/voice_name/` on volume |
| Server dies on reboot | Add `runpod.setup.sh` to pod start command or use Dockerfile image |
