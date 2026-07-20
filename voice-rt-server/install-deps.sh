#!/usr/bin/env bash
# Install voice-rt-server deps on RunPod (Python 3.11 + pip 24+).
# fairseq 0.12.2 from PyPI breaks pip resolution — use One-sixth fork first.
set -euo pipefail

echo "=== System ffmpeg (infer_rvc_python shells out to ffmpeg, not ffmpeg-python) ==="
if command -v ffmpeg >/dev/null 2>&1; then
  ffmpeg -version | head -1
else
  apt-get update -qq
  apt-get install -y -qq ffmpeg
  ffmpeg -version | head -1
fi

echo "=== Installing base packages ==="
pip install --no-cache-dir \
  fastapi==0.115.0 \
  "uvicorn[standard]==0.32.0" \
  numpy==1.26.4 \
  websockets==13.1 \
  soundfile==0.12.1

echo "=== Installing fairseq fork (Python 3.11 compatible) ==="
pip install --no-cache-dir "https://github.com/One-sixth/fairseq/archive/main.zip"

echo "=== Installing infer-rvc-python (without re-pulling broken fairseq pin) ==="
pip install --no-cache-dir infer-rvc-python==1.2.0 --no-deps
pip install --no-cache-dir \
  praat-parselmouth \
  "pyworld==0.3.2" \
  "faiss-cpu==1.7.3" \
  "torchcrepe==0.0.20" \
  ffmpeg-python \
  "typeguard==4.2.0" \
  librosa \
  gradio

echo "=== Torch (RVC needs CUDA — cu130 often fails on RunPod with error 804) ==="
TORCH_VER="$(python -c "import torch; print(torch.__version__)" 2>/dev/null || echo none)"
CUDA_OK="$(python -c "import torch; print(torch.cuda.is_available())" 2>/dev/null || echo False)"
echo "Current torch: ${TORCH_VER}  cuda.is_available=${CUDA_OK}"
if [[ "${CUDA_OK}" == "True" ]]; then
  python -c "import torch; print('GPU:', torch.cuda.get_device_name(0))"
else
  echo "Installing torch 2.4.0 + cu124 (works with RTX 4090 on most RunPod drivers)..."
  pip install --no-cache-dir torch==2.4.0 torchaudio==2.4.0 --index-url https://download.pytorch.org/whl/cu124
  python -c "import torch; assert torch.cuda.is_available(), 'CUDA still unavailable after cu124 install'; print('GPU OK:', torch.cuda.get_device_name(0))"
fi

echo "=== Verifying imports ==="
python -c "import soundfile, fastapi, uvicorn; from infer_rvc_python import BaseLoader; print('OK')"

echo "=== Done ==="
