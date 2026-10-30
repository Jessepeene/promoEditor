"""End-to-end: slice sample clips, compile a sequence using every layout, render it.

Needs the generated samples (scripts/make_samples.py); skipped otherwise.
Run with:  pytest -m e2e
"""

import time
from pathlib import Path

import pytest

from promo_server import ffmpeg_bin
from promo_server.exporter import Exporter
from promo_server.models import Cell, Clip, LayoutParams, Session, Slot, SlotFx, Zone
from promo_server.slicer import Slicer
from promo_server.timing import promo_frame_count
from promo_server.workspace import Workspace

SAMPLES = Path(__file__).resolve().parents[2] / "samples"
pytestmark = [
    pytest.mark.e2e,
    pytest.mark.skipif(not (SAMPLES / "raw").is_dir(), reason="run scripts/make_samples.py first"),
]


def _wait(pred, timeout=120):
    end = time.time() + timeout
    while time.time() < end:
        if pred():
            return
        time.sleep(0.2)
    raise TimeoutError


def test_slice_and_export(tmp_path):
    ws = Workspace(tmp_path / "ws")
    raws = sorted((SAMPLES / "raw").glob("*.mp4"))[:6]
    session = Session(fps=60, resolution=(540, 960), source_folders=[str(SAMPLES / "raw")])
    for i, raw in enumerate(raws):
        tag = (i % 3) + 1
        session.clips.append(Clip(clip_id=f"c_{i:03d}", source_path=str(raw), in_sec=4.3, anchor_sec=6.3,
                                  out_sec=8.3, energy_tag=tag, focus_xy=(0.3, 0.6)))
    session.clips.append(Clip(clip_id="c_r", source_path=str(raws[0]), mode="RANGE", in_sec=1.0, out_sec=3.5,
                              energy_tag=0))
    ws.save(session)

    slicer = Slicer(ws)
    for clip in session.clips:
        slicer.submit(clip)
    _wait(lambda: all((ws.read_sidecar(c.clip_id) or {}).get("proxy_status") in ("ready", "error")
                      for c in session.clips))
    session = ws.load()
    assert all(c.proxy_status == "ready" for c in session.clips), [c.proxy_error for c in session.clips]
    assert all(c.proxy_start_sec <= c.in_sec for c in session.clips)

    ids = [c.clip_id for c in session.clips if c.mode == "ANCHOR"]
    seq = session.sequence
    seq.bpm, seq.beat_1_offset_sec, seq.drop_beat_index = 128.0, 0.5, 4
    seq.audio_path = str(SAMPLES / "audio" / "track_128bpm.wav")
    seq.style.vhs_glitch = True
    seq.zones = [Zone(start_beat=0, end_beat=4, type="VOCAL_BREATHER"),
                 Zone(start_beat=4, end_beat=12, type="HYBRID_DROP"),
                 Zone(start_beat=12, end_beat=14, type="OUTRO")]
    drop_fx = SlotFx(bounce=True, rgb_split=True, glitch=True, shake=True, invert=True, strobe=True)
    seq.slots = [
        Slot(slot_id="s0", start_beat=0, duration_beats=4, zone_type="VOCAL_BREATHER",
             cells=[Cell(region="full", clip_id="c_r")], fx=SlotFx(speed_ramp=False, speed=0.75, echo=True,
                                                                     push="IN")),
        Slot(slot_id="s1", start_beat=4, duration_beats=1, zone_type="HYBRID_DROP",
             cells=[Cell(region="full", clip_id=ids[0])], fx=drop_fx),
        Slot(slot_id="s2", start_beat=5, duration_beats=2, zone_type="HYBRID_DROP", layout="STACK_3_ROW",
             cells=[Cell(region="row0", clip_id=ids[1]), Cell(region="row2", clip_id=ids[2]),
                    Cell(region="row1", clip_id=ids[3], end=0.5), Cell(region="row1", clip_id=ids[4], start=0.5,
                                                                      end=1.0),
                    Cell(region="row1", clip_id=ids[5], start=1.0)],
             fx=SlotFx(rgb_split=True, transition="CROSSFADE")),
        Slot(slot_id="s3", start_beat=7, duration_beats=2, zone_type="HYBRID_DROP", layout="CENTER_PIP_PUNCH",
             layout_params=LayoutParams(pip_aspect="4:3"),
             cells=[Cell(region="full", clip_id=ids[0], anchor_lock="MIDPOINT"),
                    Cell(region="pip", clip_id=ids[1], start=0.5, end=1.0),
                    Cell(region="pip", clip_id=ids[2], start=1.5, end=2.0)],
             fx=SlotFx(transition="FLASH", mirror=True)),
        Slot(slot_id="s4", start_beat=9, duration_beats=3, zone_type="HYBRID_DROP", layout="STROBE_MATRIX",
             cells=[Cell(region=f"m{i}", clip_id=ids[i % len(ids)], start=i * 0.25) for i in range(9)],
             fx=SlotFx(glitch=True, speed_ramp=False)),
        Slot(slot_id="s5", start_beat=12, duration_beats=2, zone_type="OUTRO", layout="SPLIT_2",
             layout_params=LayoutParams(split="COLS"),
             cells=[Cell(region="half0", clip_id=ids[3]), Cell(region="half1", clip_id=ids[4])],
             fx=SlotFx(push="OUT", dim=True, speed_ramp=False, transition="CROSSFADE")),
    ]
    ws.save(session)

    exporter = Exporter(ws)
    exporter.start(ws.load())
    _wait(lambda: exporter.status["state"] in ("done", "error"), timeout=600)
    assert exporter.status["state"] == "done", exporter.status.get("error")

    out = ws.resolve(exporter.status["output"])
    info = ffmpeg_bin.probe(str(out))
    frames = promo_frame_count(ws.load())
    assert info.width == 540 and info.height == 960
    assert info.has_audio
    assert info.duration == pytest.approx(frames / 60, abs=0.05)
    counted = ffmpeg_bin.run([ffmpeg_bin.ffmpeg_exe(), "-v", "error", "-i", str(out), "-map", "0:v:0",
                              "-f", "framecrc", "-"]).stdout
    assert sum(1 for line in counted.splitlines() if line and not line.startswith("#")) == frames
