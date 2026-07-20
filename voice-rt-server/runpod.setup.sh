#!/usr/bin/env bash
# Run once on your RunPod pod (Web Terminal or SSH) to install and start voice-rt-server.
set -euo pipefail

REPO="${VOICE_RT_REPO:-https://github.com/Xqlusive23/aivideo.git}"
APP_DIR="${VOICE_RT_APP_DIR:-/workspace/voice-rt-server}"
LOG="${VOICE_RT_LOG:-/workspace/voice-rt-server.log}"

echo "=== voice-rt-server RunPod setup ==="

# Pod env vars from RunPod UI are not always exported into an interactive shell.
if [[ -z "${RTC_TICKET_SECRET:-}" ]]; then
  echo "ERROR: RTC_TICKET_SECRET is not set in this shell."
  echo "RunPod -> Edit Pod -> Environment Variables, then either:"
  echo "  export RTC_TICKET_SECRET='<full secret from ledger-backend/.env>'"
  echo "or restart the Web Terminal after saving pod env vars."
  exit 1
fi

: "${VOICE_MODELS_DIR:=/models}"
: "${PORT:=8000}"

mkdir -p "${VOICE_MODELS_DIR}"

if [[ ! -f "${APP_DIR}/server.py" ]]; then
  echo "Cloning ${REPO}..."
  rm -rf /workspace/aivideo-src
  git clone --depth 1 "${REPO}" /workspace/aivideo-src
  rm -rf "${APP_DIR}"
  cp -r /workspace/aivideo-src/voice-rt-server "${APP_DIR}"
fi

cd "${APP_DIR}"

echo "Installing Python dependencies (5–15 min first time)..."
bash "${APP_DIR}/install-deps.sh"

pkill -f "python.*server.py" 2>/dev/null || true
sleep 1

echo "Starting server on 0.0.0.0:${PORT}..."
export VOICE_MODELS_DIR PORT RTC_TICKET_SECRET
nohup python server.py >>"${LOG}" 2>&1 &
sleep 2

echo ""
echo "=== Health check (local) — should respond in ~2s even while models load ==="
for i in 1 2 3 4 5; do
  if curl -sf "http://127.0.0.1:${PORT}/health"; then
    echo
    echo "=== Done — RunPod port 8000 should leave 'initializing' within ~30s ==="
    echo "Logs: tail -f ${LOG}"
    exit 0
  fi
  echo "attempt $i: not ready yet..."
  sleep 2
done

echo "Server did not respond. Running diagnostics:"
bash "${APP_DIR}/runpod.diagnose.sh" 2>/dev/null || tail -40 "${LOG}"
exit 1
