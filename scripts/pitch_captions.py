#!/usr/bin/env python3
"""Generate burned-in captions (SRT) for the pitch video.

Reads the narration text (from pitch_tts.SCENES) and per-scene durations
(from .pitch-work/audio/manifest.json), chunks the narration into ~2-line
captions, and distributes them proportionally across each scene's duration.

Output: .pitch-work/captions.srt
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pitch_tts import SCENES  # noqa: E402

GAP = 0.35  # must match pitch_video.py
AUDIO_DIR = ".pitch-work/audio"
OUT = ".pitch-work/captions.srt"
MAX_CHARS = 88  # approx 2 lines at 1920px / FontSize 22


def chunk(text, max_chars=MAX_CHARS):
    words = text.split()
    chunks, cur = [], ""
    for w in words:
        trial = (cur + " " + w).strip()
        if len(trial) <= max_chars or not cur:
            cur = trial
        else:
            chunks.append(cur)
            cur = w
    if cur:
        chunks.append(cur)
    return chunks


def fmt_ts(sec):
    ms = int(round(sec * 1000))
    h, ms = divmod(ms, 3600000)
    m, ms = divmod(ms, 60000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def main():
    with open(os.path.join(AUDIO_DIR, "manifest.json")) as f:
        manifest = json.load(f)

    t = 0.0
    entries = []
    for n in range(1, 8):
        dur = manifest[str(n)]["duration"]
        chunks = chunk(SCENES[n])
        total_chars = sum(len(c) for c in chunks)
        ct = t
        for c in chunks:
            cd = dur * (len(c) / total_chars)
            entries.append((ct, ct + cd, c))
            ct += cd
        t += dur + GAP

    with open(OUT, "w") as f:
        for i, (a, b, c) in enumerate(entries, 1):
            f.write(f"{i}\n{fmt_ts(a)} --> {fmt_ts(b)}\n{c}\n\n")
    print(f"wrote {len(entries)} captions -> {OUT}")


if __name__ == "__main__":
    main()
