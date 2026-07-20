#!/usr/bin/env python3
"""Patch server.py for PyTorch 2.6+ RVC checkpoint loading. Run on RunPod once."""
from pathlib import Path

PATCH = '''
def _patch_torch_for_rvc_checkpoints() -> None:
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
    _load._rvc_patched = True
    torch.load = _load

_patch_torch_for_rvc_checkpoints()
'''

MARKER = "_patch_torch_for_rvc_checkpoints"
INSERT_AFTER = "import uvicorn\n"

def main() -> None:
    p = Path(__file__).with_name("server.py")
    text = p.read_text()
    if MARKER in text:
        print("server.py already patched")
        return
    if INSERT_AFTER not in text:
        raise SystemExit("Could not find 'import uvicorn' in server.py — patch manually")
    text = text.replace(INSERT_AFTER, INSERT_AFTER + "\n" + PATCH + "\n", 1)
    p.write_text(text)
    print("Patched server.py OK — restart: python server.py")

if __name__ == "__main__":
    main()
