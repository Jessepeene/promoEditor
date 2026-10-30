"""Python <-> TypeScript timing parity.

Builds deterministic cases, checks them against shared/fixtures/timing_parity.json
(frontend/src/lib/timing.test.ts checks the same file). Regenerate after an
intentional timing change with:  PROMO_WRITE_FIXTURE=1 pytest tests/test_parity.py
"""

import json
import os
import random
from pathlib import Path

import pytest

from promo_server.models import Cell, Clip, LayoutParams, Session, Slot, SlotFx
from promo_server.timing import beat_to_frame, cell_timing, cell_zoom, layout_regions, shake_offset, source_time

FIXTURE = Path(__file__).resolve().parents[2] / "shared" / "fixtures" / "timing_parity.json"


def build_cases() -> dict:
    rng = random.Random(1234)
    cases = []
    for i in range(40):
        bpm = rng.choice([90.0, 120.0, 128.0, 135.0, 140.0, 174.0])
        fps = rng.choice([30, 60])
        mode = rng.choice(["ANCHOR", "ANCHOR", "RANGE"])
        in_sec = round(rng.uniform(0, 20), 3)
        anchor = round(in_sec + rng.uniform(0.3, 2.0), 3)
        out_sec = round(anchor + rng.uniform(0.3, 2.0), 3)
        slot = {
            "slot_id": f"s{i}", "start_beat": rng.choice([0, 4, 7.5, 16.25]),
            "duration_beats": rng.choice([0.25, 0.5, 1, 2, 3, 4, 8]), "zone_type": "HYBRID_DROP",
            "fx": {"speed_ramp": rng.random() < 0.7, "speed": rng.choice([0.75, 1.0, 1.5])},
        }
        cell = {"region": rng.choice(["full", "full", "row1", "m3"]), "clip_id": "c",
                "start": rng.choice([0, 0, 0.25, 0.5]), "end": rng.choice([None, None, 1.0]),
                "slip_frames": rng.choice([0, 0, 2, -4]), "anchor_lock": rng.choice(["DOWNBEAT", "MIDPOINT"])}
        clip = {"clip_id": "c", "source_path": "x", "mode": mode, "in_sec": in_sec,
                "anchor_sec": anchor if mode == "ANCHOR" else None, "out_sec": out_sec}
        session = Session(fps=fps)
        session.sequence.bpm = bpm
        s, c, cl = Slot.model_validate(slot), Cell.model_validate(cell), Clip.model_validate(clip)
        t = cell_timing(session, s, c, cl)
        frames = sorted({0, 1, t.n_frames // 3, t.n_frames // 2, t.n_frames - 1, t.n_frames})
        cases.append({
            "bpm": bpm, "fps": fps, "slot": slot, "cell": cell, "clip": clip,
            "start_frame": t.start_frame, "end_frame": t.end_frame, "scale": t.scale,
            "samples": [[f, source_time(t, f, fps)] for f in frames],
        })
    regions = {}
    for layout, params in [("FULLSCREEN_VELOCITY", {}), ("STACK_3_ROW", {}),
                           ("CENTER_PIP_PUNCH", {"pip_aspect": "4:3", "pip_background": "STACK"}),
                           ("CENTER_PIP_PUNCH", {"pip_aspect": "1:1"}), ("STROBE_MATRIX", {"matrix": "3x4"}),
                           ("STROBE_MATRIX", {"matrix": "2x5"}), ("SPLIT_2", {"split": "ROWS"}),
                           ("SPLIT_2", {"split": "COLS"})]:
        for w, h in [(1080, 1920), (720, 1280), (1000, 1778)]:
            key = f"{layout}|{json.dumps(params, sort_keys=True)}|{w}x{h}"
            regions[key] = {k: list(v) for k, v in layout_regions(layout, LayoutParams(**params), w, h).items()}
    frames = {f"{b}|{bpm}|{fps}": beat_to_frame(b, bpm, fps)
              for b in [0, 0.25, 1, 3.75, 16, 47.5, 100] for bpm in [120.0, 135.0, 174.0] for fps in [30, 60]}
    motion = [
        {"t": t, "dur": dur, "bounce": bounce, "push": push, "shake": shake,
         "zoom": cell_zoom(t, dur, bounce, push, shake), "shake_offset": list(shake_offset(t))}
        for t in (0.0, 0.016, 0.1, 0.5, 1.7) for dur in (0.47, 1.875)
        for bounce in (False, True) for push in ("NONE", "IN", "OUT") for shake in (False, True)
    ]
    return {"cases": cases, "regions": regions, "beat_frames": frames, "motion": motion}


def test_fixture_matches_python():
    data = build_cases()
    if os.environ.get("PROMO_WRITE_FIXTURE") == "1" or not FIXTURE.exists():
        FIXTURE.parent.mkdir(parents=True, exist_ok=True)
        FIXTURE.write_text(json.dumps(data, indent=1))
    stored = json.loads(FIXTURE.read_text())
    assert stored["regions"] == data["regions"]
    assert stored["beat_frames"] == data["beat_frames"]
    for a, b in zip(stored["motion"], data["motion"], strict=True):
        assert a["zoom"] == pytest.approx(b["zoom"], abs=1e-12)
        assert a["shake_offset"] == pytest.approx(b["shake_offset"], abs=1e-12)
    for a, b in zip(stored["cases"], data["cases"]):
        assert a["start_frame"] == b["start_frame"] and a["end_frame"] == b["end_frame"]
        for (fa, sa), (fb, sb) in zip(a["samples"], b["samples"]):
            assert fa == fb and sa == pytest.approx(sb, abs=1e-9)
