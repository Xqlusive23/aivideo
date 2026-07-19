# InspireTech Desktop App

Shippable Windows desktop app that loads the InspireTech web UI and exposes
transformed video (and audio routing setup) to calling apps via virtual drivers.

## What gets installed on first launch

| Component | Driver | Shows up in calling apps as |
|-----------|--------|----------------------------|
| Virtual camera | Unity Capture (MIT) | **InspireTech Camera** |
| Virtual audio | VB-CABLE (donationware) | **CABLE Output (VB-Audio Virtual Cable)** |

On first launch, a setup wizard runs before the main window. Click **Install
drivers** — Windows will show UAC prompts for each driver (required by Windows,
cannot be skipped).

## Development

### 1. Run the web app
```powershell
cd c:\Projects\aivideo
npm run dev
```

### 2. Run the desktop shell (loads localhost:5173)
```powershell
cd aivideo-companion
npm install
npm run dev
```

Optional: use a local Python feeder instead of PyInstaller build:
```powershell
python -m venv venv
venv\Scripts\activate
pip install -r requirements-feeder.txt
$env:INSPIRETECH_PYTHON="venv\Scripts\python.exe"
npm run dev
```

## Building a downloadable installer

### Prerequisites
- Node.js 18+
- Python 3.10+ with pip
- Git (for Unity Capture driver download during build)

### 1. Bundle VB-CABLE installer (required for audio auto-install)

Download `VBCABLE_Setup_x64.exe` from https://vb-audio.com/Cable/ and place it in:
```
aivideo-companion/resources/drivers/vb-cable/VBCABLE_Setup_x64.exe
```

See VB-Audio licensing if distributing to end users:
https://vb-audio.com/Services/licensing.htm

### 2. Build
```powershell
cd aivideo-companion
npm install
pip install -r requirements-feeder.txt
npm run dist
```

Output: `aivideo-companion/release/InspireTech Setup 0.2.0.exe`

If the build fails with **"app.asar is being used by another process"**:
1. Close any running **InspireTech.exe** (Task Manager)
2. Run `npm run clean`
3. If it still fails, delete the old `dist-electron` folder manually and rebuild

Build output now goes to `release/` (not `dist-electron/`).

### Build steps (what `npm run dist` does)
1. `vite build` — bundles React app to `../dist`
2. `pyinstaller` — bundles `virtualcam_feeder.py` and `audio_feeder.py` into `resources/feeder/`
3. `prepare:drivers` — copies Unity Capture DLLs into `resources/drivers/unity-capture`
4. `electron-builder` — packages everything into an NSIS installer

### Unpacked build (faster, for testing)
```powershell
npm run dist:dir
```
Run: `release/win-unpacked/InspireTech.exe`

## Using in calling apps

After setup and starting a transformation in InspireTech:

- **Camera:** select **InspireTech Camera**
- **Microphone:** select **CABLE Output (VB-Audio Virtual Cable)**

While a transformation is **live**, InspireTech routes audio to VB-CABLE:
- **Voice changer ON** → converted voice goes to the virtual mic
- **Voice changer OFF** → your raw mic goes to the virtual mic

Open your calling app (Zoom, Telegram, Discord) and pick those devices before or during the call.

## Environment variables (dev)

| Variable | Default | Purpose |
|----------|---------|---------|
| `INSPIRETECH_DEV` | `1` in `npm run dev` | Load `http://localhost:5173` |
| `INSPIRETECH_URL` | — | Override app URL entirely |
| `INSPIRETECH_APP_URL` | `https://www.inspirestream.xyz/#/app` | Live studio URL in packaged builds |
| `INSPIRETECH_PYTHON` | `python` | Python for dev feeder |

## Production updates (no reinstall for UI changes)

Packaged builds open **https://www.inspirestream.xyz/#/app** instead of a frozen copy
bundled inside the installer. When you deploy the website (Vercel) or ledger backend
(Railway), desktop users get those changes the next time they open InspireTech — voice
changer (ElevenLabs), credits, login fixes, etc. all use the same live APIs as the browser.

You only need a **new installer** when the desktop shell changes (drivers, feeders,
Electron, or this `paths.js` behavior). Bump `version` in `package.json`, run
`npm run dist`, and publish a GitHub release.

## Code signing

Unsigned builds trigger Windows SmartScreen. For public distribution, sign the
installer with an Authenticode certificate.

## Known limits

- Video to virtual camera (~20 fps via IPC)
- Audio ~20ms frames — slight latency on voice-changed output (ElevenLabs chunk mode adds its own delay on top)
- VB-CABLE must be placed manually before building (licensing)
- Driver install requires UAC approval on first run
- Windows only

## WhatsApp Desktop compatibility

**InspireTech Camera will not appear in WhatsApp Desktop** on Windows. This is
not a bug in InspireTech — it is an API mismatch:

| App type | Camera API | InspireTech Camera |
|----------|------------|-------------------|
| Telegram, Discord, Zoom (most builds) | DirectShow (or hybrid) | Works |
| WhatsApp Desktop | Media Foundation only | **Not listed** |

Unity Capture (what we use today) is a **DirectShow** filter. WhatsApp Desktop
only enumerates **Media Foundation** cameras — the same reason OBS Virtual Camera
does not show up there either.

### Workarounds today

1. **Use Telegram / Discord / Zoom** for video calls with InspireTech Camera
   (already works).

2. **WhatsApp Web** in Chrome or Edge — open [web.whatsapp.com](https://web.whatsapp.com),
   start a video call, and check if **InspireTech Camera** appears in the browser
   camera picker. Browsers often expose DirectShow devices even when the desktop
   app does not.

3. **SplitCam bridge** (free) — some users feed a DirectShow source into
   [SplitCam](https://splitcam.com/), which registers a camera WhatsApp Desktop
   can see. Manual extra setup; not bundled with InspireTech.

4. **Pop Out window** — use the in-app “Pop Out for OBS” button and capture that
   floating window if your calling app supports window capture (WhatsApp Desktop
   video calls do not — this helps OBS/other tools only).

### Planned fix (Win11+)

A **Media Foundation** virtual camera via `MFCreateVirtualCamera` (Windows 11
22H2+) would make InspireTech appear in WhatsApp Desktop. This requires a native
C++ media source component — on the roadmap as a follow-up to the current
DirectShow path.
