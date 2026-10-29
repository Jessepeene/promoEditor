"""Generate synthetic sample media for trying the suite without real footage.

    backend/.venv/Scripts/python scripts/make_samples.py

Writes samples/raw/*.mp4 (mixed landscape/portrait, 1s GOP like camera files)
and samples/audio/track_128bpm.wav: 16-beat intro, 16-beat build with a snare
roll, then a 32-beat drop. Beat 0 is at 0.5s, so the drop kick lands on
beat 32 at 0.5 + 32 * 0.46875 = 15.5s.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from promo_server.ffmpeg_bin import ffmpeg_exe  # noqa: E402

OUT = Path(__file__).resolve().parents[1] / "samples"

CLIPS = [
    ("crowd_wide", "testsrc2=s=1920x1080:r=30", "hue=h=t*25"),
    ("dj_hands", "mandelbrot=s=1280x720:r=30", "hue=s=1.6"),
    ("strobe_hit", "life=s=1280x720:r=60:mold=10:ratio=0.2:death_color=#101030:life_color=#ff2080", "scale=1920:1080"),
    ("car_orbit", "cellauto=s=1280x720:r=30:rule=110", "scale=1920:1080,hue=h=200"),
    ("dancer_vert", "testsrc2=s=1080x1920:r=60", "hue=h=t*60:s=1.5"),
    ("confetti", "rgbtestsrc=s=1280x720:r=30", "hue=h=t*90,boxblur=4"),
    ("bass_face", "smptehdbars=s=1920x1080:r=30", "hue=h=t*45"),
    ("headlights", "mandelbrot=s=1080x1920:r=30:start_scale=2", "hue=h=120"),
]

BPM = 128.0
BEAT = 60.0 / BPM
OFFSET = 0.5


def track_expr() -> str:
    b = f"((t-{OFFSET})/{BEAT})"  # beat position
    ph = f"(mod(t-{OFFSET},{BEAT}))"  # time since last beat
    kick = f"0.9*sin(2*PI*(50+120*exp(-30*{ph}))*{ph})*exp(-9*{ph})"
    half = f"(mod(t-{OFFSET}+{BEAT}/2,{BEAT}))"
    hat = f"0.25*(random(0)*2-1)*exp(-60*{half})"
    roll_ph = f"(mod(t-{OFFSET},{BEAT}/4))"
    snare_roll = f"0.35*(random(1)*2-1)*exp(-35*{roll_ph})*(({b}-16)/16)"
    bass = f"0.35*sin(2*PI*55*t)*(1-exp(-20*{ph}))*exp(-2*{ph})"
    intro = f"lt({b},16)*(0.6*{kick}+{hat})"
    build = f"gte({b},16)*lt({b},32)*(0.4*{kick}+{snare_roll})"
    drop = f"gte({b},32)*({kick}+{hat}+{bass})"
    return f"gte(t,{OFFSET})*({intro}+{build}+{drop})*0.8"


def main() -> None:
    ff = ffmpeg_exe()
    (OUT / "raw").mkdir(parents=True, exist_ok=True)
    (OUT / "audio").mkdir(parents=True, exist_ok=True)
    for name, src, vf in CLIPS:
        target = OUT / "raw" / f"{name}.mp4"
        if target.exists():
            continue
        fps = 60 if "r=60" in src else 30
        subprocess.run([ff, "-y", "-v", "error", "-f", "lavfi", "-i", src, "-t", "14", "-vf", f"{vf},format=yuv420p",
                        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-g", str(fps), "-bf", "2",
                        str(target)], check=True)
        print("wrote", target)
    track = OUT / "audio" / "track_128bpm.wav"
    duration = OFFSET + 64 * BEAT + 1.0
    subprocess.run([ff, "-y", "-v", "error", "-f", "lavfi", "-i",
                    f"aevalsrc='{track_expr()}':s=44100:d={duration:.3f}", "-ac", "2", str(track)], check=True)
    print("wrote", track)


if __name__ == "__main__":
    main()
