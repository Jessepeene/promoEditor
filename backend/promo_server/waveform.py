"""Audio waveform peak extraction (decoded by ffmpeg, reduced with numpy)."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import numpy as np

from . import ffmpeg_bin

SAMPLE_RATE = 11025
PEAKS_PER_SEC = 200


def extract_peaks(audio: Path, cache_dir: Path) -> dict:
    stat = audio.stat()
    key = hashlib.sha1(f"{audio.resolve()}|{stat.st_size}|{stat.st_mtime_ns}".encode()).hexdigest()[:16]
    cache = cache_dir / f"waveform_{key}.json"
    if cache.exists():
        return json.loads(cache.read_text())

    raw = ffmpeg_bin.run_bytes(
        [ffmpeg_bin.ffmpeg_exe(), "-v", "error", "-i", str(audio), "-ac", "1", "-ar", str(SAMPLE_RATE),
         "-f", "s16le", "-"],
        timeout=300,
    )
    if raw.returncode != 0:
        raise RuntimeError(raw.stderr.decode(errors="replace")[-400:])
    samples = np.frombuffer(raw.stdout, dtype="<i2").astype(np.float32) / 32768.0
    bucket = SAMPLE_RATE // PEAKS_PER_SEC
    n = len(samples) // bucket
    frames = np.abs(samples[: n * bucket]).reshape(n, bucket)
    peaks = frames.max(axis=1)
    rms = np.sqrt((frames**2).mean(axis=1))
    norm = float(peaks.max()) or 1.0
    result = {
        "duration": len(samples) / SAMPLE_RATE,
        "peaks_per_sec": PEAKS_PER_SEC,
        "peaks": np.round(peaks / norm, 3).tolist(),
        "rms": np.round(rms / norm, 3).tolist(),
    }
    cache.write_text(json.dumps(result))
    return result
