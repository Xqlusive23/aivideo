# Running locally in Python — setup guide

This runs the character-transformation model directly on your machine (CPU
or GPU) and outputs to a real virtual camera, so it shows up in Zoom,
Discord, Teams, OBS, Twitch — anywhere a webcam can be selected — **without**
needing OBS running at the same time.

## 1. Python environment

```bash
cd local-inference
python -m venv venv

# Windows
venv\Scripts\activate
# Mac/Linux
source venv/bin/activate
```

## 2. Install PyTorch — pick ONE of these, matching your hardware

**If you have an NVIDIA GPU** (recommended — see the performance note below):
```bash
pip install torch --index-url https://download.pytorch.org/whl/cu124
```
(Check https://pytorch.org/get-started/locally/ for the exact CUDA version matching your installed NVIDIA drivers if `cu124` doesn't work.)

**If you don't have an NVIDIA GPU (CPU-only):**
```bash
pip install torch --index-url https://download.pytorch.org/whl/cpu
```

## 3. Install everything else

```bash
pip install -r requirements.txt
```

## 4. Add your reference image

Drop a photo of the character/person you want to become into this folder as
`reference.jpg` (or edit `REFERENCE_IMAGE_PATH` in `live_transform.py` to
point elsewhere).

## 5. (Windows only) One-time virtual camera driver install

This is the step that lets you skip OBS entirely at runtime:

1. Download UnityCapture: https://github.com/schellingb/UnityCapture (green "Code" button → Download ZIP)
2. Extract it, open the `Install` folder inside
3. Right-click `Install.bat` → **Run as administrator**
4. Done — a "Unity Video Capture" device now exists system-wide. You never
   need to run this again unless you reinstall Windows or move the files.

You do **not** need Unity (the game engine) or OBS installed for this —
UnityCapture is just the name of the driver project.

If you skip this step, the script still runs and shows a plain preview
window instead — useful for testing the model itself first.

## 6. Run it

```bash
python live_transform.py
```

First run downloads several GB of model weights — subsequent runs are fast
to start. Once it's running, open Zoom/Discord/Teams/OBS and select
**"Unity Video Capture"** as your camera.

## Honest performance expectations

| Hardware | Expect roughly |
|---|---|
| Modern NVIDIA GPU (RTX 3060+) | ~7-10 fps with SD1.5 + LCM-LoRA |
| Older/weaker GPU | Slower — consider lowering `OUTPUT_WIDTH`/`OUTPUT_HEIGHT` below 512 |
| CPU only | Several seconds per frame — fine for verifying setup, not usable live |

## If you tried the SDXL-Turbo version first and hit MemoryError

This script now uses SD1.5 + LCM-LoRA instead — roughly a third the size of
SDXL-Turbo, which should actually fit in RAM on a normal machine. If you hit
disk-space or memory errors on an earlier run, two cleanup steps are worth
doing:

**1. Reclaim the wasted disk space** — the failed SDXL-Turbo downloads are
still sitting in your Hugging Face cache doing nothing useful:
```powershell
rmdir /s /q "%USERPROFILE%\.cache\huggingface\hub\models--stabilityai--sdxl-turbo"
rmdir /s /q "%USERPROFILE%\.cache\huggingface\hub\models--h94--IP-Adapter"
```
(The second one also clears the SDXL IP-Adapter files — safe to delete, this
script will re-download only the much smaller SD1.5 versions it actually needs now.)

**2. If your `C:` drive stays tight on space generally**, redirect where the
Hugging Face cache lives to a drive with more room, e.g.:
```powershell
setx HF_HOME "D:\huggingface_cache"
```
(Open a **new** terminal after running this for it to take effect — `setx`
doesn't affect your current session.)


This is noticeably choppier than Decart's ~30fps. It's a legitimate starting
point (Phase 1), not the finished product — see our earlier discussion on
Phase 2 optimizations (TensorRT, lower resolution, batching) to close that gap.

## If something goes wrong

- **"Could not open webcam index 0"** — try `WEBCAM_INDEX = 1` (or higher) in
  `live_transform.py` if you have multiple cameras.
- **Virtual camera fails to open** — confirm step 5 above was actually run
  as administrator; check Windows' camera privacy settings allow app access.
- **Out of memory (CUDA)** — lower `OUTPUT_WIDTH`/`OUTPUT_HEIGHT`. SDXL-Turbo is heavier than a plain SD1.5 model; there's no smaller drop-in swap here without also swapping to a matching IP-Adapter checkpoint (see below).
- **IP-Adapter file not found / shape mismatch error** — `MODEL_ID`, `IP_ADAPTER_SUBFOLDER`, and `IP_ADAPTER_WEIGHT_NAME` must all belong to the *same* model family. This script is set up for SDXL-Turbo specifically (`sdxl_models`/`ip-adapter_sdxl.bin`/1280-dim ViT-bigG encoder). Don't swap `MODEL_ID` to a different base model without also swapping the matching IP-Adapter files — mismatched pairs cause a `expected shape ... but got shape ...` error at load time.
