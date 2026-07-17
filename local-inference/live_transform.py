"""
live_transform.py — runs the character-transformation model locally on your
webcam feed and outputs it as a real system virtual camera (bypassing OBS at
runtime), or falls back to a plain preview window if no virtual camera
backend is available yet.

Usage:
    python live_transform.py

Config: edit the constants right below the imports.

--------------------------------------------------------------------------
ONE-TIME SETUP (Windows) for the actual virtual-camera output:
  1. Download UnityCapture: https://github.com/schellingb/UnityCapture
  2. Extract it, open the "Install" folder, right-click Install.bat ->
     "Run as administrator". This registers a "Unity Video Capture" device
     in Windows. You do NOT need Unity itself, or OBS, installed for this.
  3. That's it — no need to run it again unless you reinstall Windows or
     move the files.

Without that one-time install, this script still runs fine — it just shows
a plain preview window instead of feeding a real virtual camera, so you can
develop/test the model itself before bothering with the camera step.
--------------------------------------------------------------------------
"""

import time
import sys
from pathlib import Path

import cv2
import numpy as np
import torch
from PIL import Image
from diffusers import AutoPipelineForImage2Image, LCMScheduler
from transformers import CLIPVisionModelWithProjection

# --- Config ----------------------------------------------------------------
REFERENCE_IMAGE_PATH = "reference.jpg"  # the character/photo you want to become
WEBCAM_INDEX = 0                        # 0 is usually your default camera
OUTPUT_WIDTH = 512
OUTPUT_HEIGHT = 512
TARGET_FPS = 15                         # aspirational — real achieved FPS is printed live

MODEL_ID = "stable-diffusion-v1-5/stable-diffusion-v1-5"  # ~3x lighter than SDXL — should actually fit in your RAM
LCM_LORA_ID = "latent-consistency/lcm-lora-sdv1-5"         # fast-sampling technique for SD1.5 (different mechanism from "Turbo" models)
IP_ADAPTER_REPO = "h94/IP-Adapter"
IP_ADAPTER_SUBFOLDER = "models"                 # SD1.5 variant — must match MODEL_ID's family
IP_ADAPTER_WEIGHT_NAME = "ip-adapter_sd15.bin"  # pairs with the 1024-dim ViT-H encoder below
IP_ADAPTER_SCALE = 0.6                  # 0-1, how strongly the reference image influences output
DENOISE_STRENGTH = 0.5                  # 0-1, how much the original frame is altered
PROMPT = "high quality photo"           # kept generic — the reference image does the real driving
NUM_INFERENCE_STEPS = 4                 # LCM-LoRA's sweet spot is ~4 steps (unlike Turbo's 1-2)
GUIDANCE_SCALE = 1.5                    # LCM-LoRA wants a little CFG, unlike Turbo's guidance_scale=0.0

# Once you've had ONE fully successful run (everything downloaded), flip this
# to True. It skips every network call to Hugging Face entirely — meaning a
# Hub outage (like the 504 Gateway Timeout you just hit) can never break a
# run again, since nothing after that first download actually needs the
# network. Leave False only for your very first run, or after adding a new
# model/adapter that hasn't been downloaded yet.
LOCAL_FILES_ONLY = False

# SD1.5's built-in safety checker has a real false-positive rate on ordinary
# webcam content (returns a solid black frame instead when triggered — that's
# what you just saw, not a bug). Fine to disable for your OWN local testing.
#
# IMPORTANT if/when this becomes the real hosted service other people use
# (Phase 2/3 of replacing Decart): this app lets a user upload a reference
# image of someone else's face/character to drive live video transformation
# of a person's real webcam feed — exactly the kind of feature that can be
# misused to produce non-consensual explicit imagery of real people if
# there's no content moderation at all. Keep some form of safety checking
# (this one, or a better one) once real users are involved — don't ship this
# flag as False to production without deciding that deliberately.
DISABLE_SAFETY_CHECKER = False

# --- Device setup ------------------------------------------------------------
def pick_device():
    if torch.cuda.is_available():
        return "cuda", torch.float16
    print(
        "\n⚠️  No CUDA GPU detected — running on CPU. This WILL work, but expect "
        "several seconds per frame, not real-time. This mode is for verifying "
        "the pipeline/model/reference-image setup is correct, not for actual "
        "live use. See our earlier discussion: real-time performance needs a GPU.\n"
    )
    return "cpu", torch.float32


def load_pipeline(device, dtype):
    print(f"Loading {MODEL_ID} on {device} ({dtype})... this downloads several GB on first run.")
    if LOCAL_FILES_ONLY:
        print("(LOCAL_FILES_ONLY=True — skipping Hugging Face entirely, using only what's cached)")

    # Load the matching CLIP vision encoder EXPLICITLY, rather than letting
    # load_ip_adapter() auto-detect it below. Auto-detection is what caused
    # the "expected 1024, got 768" shape-mismatch error — this is HuggingFace's
    # own documented fix for that specific failure.
    print("Loading matching CLIP image encoder...")
    image_encoder = CLIPVisionModelWithProjection.from_pretrained(
        IP_ADAPTER_REPO,
        subfolder=f"{IP_ADAPTER_SUBFOLDER}/image_encoder",
        torch_dtype=dtype,
        local_files_only=LOCAL_FILES_ONLY,
    )

    pipe_kwargs = dict(
        image_encoder=image_encoder,
        torch_dtype=dtype,
        variant="fp16" if device == "cuda" else None,
        local_files_only=LOCAL_FILES_ONLY,
    )
    if DISABLE_SAFETY_CHECKER:
        pipe_kwargs["safety_checker"] = None
        pipe_kwargs["requires_safety_checker"] = False

    pipe = AutoPipelineForImage2Image.from_pretrained(MODEL_ID, **pipe_kwargs).to(device)

    print(f"Loading IP-Adapter ({IP_ADAPTER_WEIGHT_NAME})...")
    pipe.load_ip_adapter(
        IP_ADAPTER_REPO,
        subfolder=IP_ADAPTER_SUBFOLDER,
        weight_name=IP_ADAPTER_WEIGHT_NAME,
        local_files_only=LOCAL_FILES_ONLY,
    )
    pipe.set_ip_adapter_scale(IP_ADAPTER_SCALE)

    # LCM-LoRA: a small set of extra weights + a matching scheduler that lets
    # SD1.5 generate in ~4 steps instead of the usual 20-50. Officially
    # documented to work together with IP-Adapter (unlike our earlier,
    # unsupported attempt to mix a Turbo model with a mismatched adapter).
    print("Loading LCM-LoRA for fast sampling...")
    pipe.load_lora_weights(LCM_LORA_ID, local_files_only=LOCAL_FILES_ONLY)
    pipe.scheduler = LCMScheduler.from_config(pipe.scheduler.config)

    # Reduces VRAM pressure at a small speed cost — helpful on smaller GPUs.
    if device == "cuda":
        pipe.enable_attention_slicing()

    return pipe


def load_reference_image():
    path = Path(REFERENCE_IMAGE_PATH)
    if not path.exists():
        print(f"\n❌ Reference image not found at '{path}'. Put a photo there (or edit "
              f"REFERENCE_IMAGE_PATH at the top of this file) and run again.\n")
        sys.exit(1)
    return Image.open(path).convert("RGB").resize((OUTPUT_WIDTH, OUTPUT_HEIGHT))


def open_virtual_camera():
    """Tries to open a real virtual camera; falls back to None (preview-window
    mode) if no backend is available yet — e.g. UnityCapture isn't installed."""
    try:
        import pyvirtualcam
        cam = pyvirtualcam.Camera(
            width=OUTPUT_WIDTH,
            height=OUTPUT_HEIGHT,
            fps=TARGET_FPS,
            backend="unitycapture",  # explicit: skip the 'obs' backend so this genuinely doesn't need OBS
        )
        print(f"\n✅ Virtual camera active: {cam.device}")
        print("   Select this device as your camera in Zoom/Discord/Teams/OBS/etc.\n")
        return cam
    except Exception as err:
        print(
            f"\n⚠️  Couldn't open a virtual camera ({err}). Falling back to a preview "
            "window instead — install UnityCapture (see the header of this file) to "
            "get real virtual-camera output.\n"
        )
        return None


def main():
    device, dtype = pick_device()
    pipe = load_pipeline(device, dtype)
    reference_image = load_reference_image()
    cam = open_virtual_camera()

    webcam = cv2.VideoCapture(WEBCAM_INDEX, cv2.CAP_DSHOW)
    if not webcam.isOpened():
        print(f"❌ Could not open webcam index {WEBCAM_INDEX}.")
        sys.exit(1)
    webcam.set(cv2.CAP_PROP_FRAME_WIDTH, OUTPUT_WIDTH)
    webcam.set(cv2.CAP_PROP_FRAME_HEIGHT, OUTPUT_HEIGHT)

    print("Running. Press Ctrl+C (or 'q' in the preview window) to stop.\n")
    frame_count = 0
    fps_timer = time.time()

    try:
        consecutive_failures = 0
        while True:
            ok, bgr_frame = webcam.read()
            if not ok:
                consecutive_failures += 1
                print(f"⚠️  Failed to read a frame from the webcam (attempt {consecutive_failures})...")
                if consecutive_failures >= 20:
                    print(
                        "\n❌ Camera isn't responding after 20 attempts. Likely causes:\n"
                        "   - Another app has the camera open (close Zoom/Teams/browser tabs/Windows Camera app)\n"
                        "   - Wrong WEBCAM_INDEX — try 1, 2, etc. if you have multiple cameras\n"
                        "   - A driver issue unrelated to this script\n"
                    )
                    sys.exit(1)
                time.sleep(0.5)
                continue
            consecutive_failures = 0

            bgr_frame = cv2.resize(bgr_frame, (OUTPUT_WIDTH, OUTPUT_HEIGHT))
            rgb_frame = cv2.cvtColor(bgr_frame, cv2.COLOR_BGR2RGB)
            input_image = Image.fromarray(rgb_frame)

            result = pipe(
                prompt=PROMPT,
                image=input_image,
                ip_adapter_image=reference_image,
                num_inference_steps=NUM_INFERENCE_STEPS,
                strength=DENOISE_STRENGTH,
                guidance_scale=GUIDANCE_SCALE,  # LCM-LoRA, not a Turbo model — see config comment above
            ).images[0]

            output_rgb = np.array(result)

            if cam is not None:
                cam.send(output_rgb)
                cam.sleep_until_next_frame()
            else:
                preview_bgr = cv2.cvtColor(output_rgb, cv2.COLOR_RGB2BGR)
                cv2.imshow("Live Transform Preview (no virtual cam installed)", preview_bgr)
                if cv2.waitKey(1) & 0xFF == ord("q"):
                    break

            frame_count += 1
            print_every = 1 if device == "cpu" else 30
            if frame_count % print_every == 0:
                elapsed = time.time() - fps_timer
                print(f"~{print_every / elapsed:.2f} fps  (frame {frame_count})")
                fps_timer = time.time()

    except KeyboardInterrupt:
        print("\nStopping...")
    finally:
        webcam.release()
        if cam is not None:
            cam.close()
        cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
