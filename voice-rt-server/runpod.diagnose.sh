#!/usr/bin/env bash
# Quick diagnostics when RunPod port 8000 shows "Waiting for service to respond".
set -u

echo "=== voice-rt-server diagnostics ==="
echo "Time: $(date -Is 2>/dev/null || date)"
echo

echo "--- Pod env (must be set before starting server) ---"
for v in RTC_TICKET_SECRET VOICE_MODELS_DIR PORT; do
  if [[ -n "${!v:-}" ]]; then
    if [[ "$v" == "RTC_TICKET_SECRET" ]]; then
      echo "$v=set (${#RTC_TICKET_SECRET} chars)"
    else
      echo "$v=${!v}"
    fi
  else
    echo "$v=MISSING"
  fi
done
echo

echo "--- Python ---"
python --version 2>&1 || python3 --version 2>&1
echo

echo "--- Port 8000 listener ---"
if command -v ss >/dev/null 2>&1; then
  ss -ltnp | grep ':8000' || echo "nothing listening on 8000"
elif command -v netstat >/dev/null 2>&1; then
  netstat -ltnp 2>/dev/null | grep ':8000' || echo "nothing listening on 8000"
else
  curl -sf --max-time 2 "http://127.0.0.1:8000/health" >/dev/null && echo "health responds locally" || echo "health does NOT respond locally"
fi
echo

echo "--- Local /health ---"
curl -s --max-time 5 "http://127.0.0.1:${PORT:-8000}/health" || echo "(no response)"
echo
echo

echo "--- server.py process ---"
pgrep -af "python.*server.py" || echo "no server.py process"
echo

LOG="${VOICE_RT_LOG:-/workspace/voice-rt-server.log}"
if [[ -f "$LOG" ]]; then
  echo "--- Last 40 log lines ($LOG) ---"
  tail -40 "$LOG"
else
  echo "--- No log at $LOG ---"
fi
echo

echo "--- /models volume ---"
MODELS="${VOICE_MODELS_DIR:-/models}"
if [[ -d "$MODELS" ]]; then
  ls -la "$MODELS" 2>/dev/null || true
  find "$MODELS" -maxdepth 2 -name 'model.pth' 2>/dev/null || echo "no model.pth files found"
else
  echo "$MODELS does not exist"
fi
echo

echo "=== Fix checklist ==="
echo "1. export RTC_TICKET_SECRET=...  (full string from ledger-backend/.env)"
echo "2. cd /workspace/aivideo/voice-rt-server && pip install -r requirements.txt"
echo "3. python server.py   (foreground first — watch errors)"
echo "4. When OK: nohup python server.py >>/workspace/voice-rt-server.log 2>&1 &"
