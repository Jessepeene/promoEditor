"""Browser-rendered text layer: span validation and frame-exact placement in ffmpeg."""

import numpy as np
import pytest
from pydantic import ValidationError

from promo_server import ffmpeg_bin
from promo_server.compiler import write_text_concat
from promo_server.models import TextTrack


def _png(path, color):
    res = ffmpeg_bin.run([ffmpeg_bin.ffmpeg_exe(), "-y", "-v", "error", "-f", "lavfi", "-i",
                          f"color=c={color}:s=64x36,format=rgba", "-frames:v", "1", str(path)])
    assert res.returncode == 0, res.stderr


def test_rejects_bad_spans():
    base = dict(fps=60, width=64, height=36, total_frames=100)
    with pytest.raises(ValidationError):
        TextTrack(**base, spans=[{"file": "t_0001.png", "start": 10, "end": 20},
                                 {"file": "t_0002.png", "start": 15, "end": 30}])  # overlap
    with pytest.raises(ValidationError):
        TextTrack(**base, spans=[{"file": "../evil.png", "start": 0, "end": 5}])  # path in name
    with pytest.raises(ValidationError):
        TextTrack(**base, spans=[{"file": "t_0001.png", "start": 90, "end": 120}])  # past the end


def test_text_frames_land_on_exact_frames(tmp_path):
    _png(tmp_path / "t_0001.png", "red@1.0")
    _png(tmp_path / "t_0002.png", "blue@1.0")
    track = TextTrack(fps=60, width=64, height=36, total_frames=200, spans=[
        {"file": "t_0001.png", "start": 30, "end": 60},
        {"file": "t_0002.png", "start": 60, "end": 61},  # single-frame span
        {"file": "t_0001.png", "start": 150, "end": 200},  # runs to the very end
    ])
    concat = write_text_concat(track, tmp_path, tmp_path)
    # The repeated last entry the concat demuxer needs runs past the end; the export's final
    # pass is capped with -frames:v, so cap here the same way.
    res = ffmpeg_bin.run_bytes([ffmpeg_bin.ffmpeg_exe(), "-v", "error", "-f", "concat", "-safe", "0", "-i",
                                str(concat), "-vf", "fps=60,format=rgba", "-frames:v", "200", "-f", "rawvideo", "-"])
    assert res.returncode == 0, res.stderr
    frames = np.frombuffer(res.stdout, np.uint8).reshape(-1, 36, 64, 4)
    assert len(frames) == 200
    alpha = frames[:, 18, 32, 3]
    red = frames[:, 18, 32, 0]
    blue = frames[:, 18, 32, 2]
    assert (alpha[:30] == 0).all() and (alpha[61:150] == 0).all()
    assert (red[30:60] == 255).all() and (alpha[30:60] == 255).all()
    assert blue[60] == 255 and red[60] == 0
    assert (red[150:] == 255).all()
