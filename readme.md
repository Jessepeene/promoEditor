# promoEditor

Local-first tool for cutting beat-synced event promo videos (9:16, 1080x1920).

- **Logger** – scrub raw footage and tag moments with hotkeys (`1`/`2`/`3` anchors, hold `4` for ranges). Each mark is sliced losslessly in the background.
- **Generator** – set BPM and drop, lay out zones (intro, stutter build, breather, drop), and roll a sequence of Beat Cards from the clip pool. Lock cards you like, reroll the rest, preview in real time, export to MP4.

> **Status:** the backend (slicing, waveform, export) and the core logic (timing, solver, BPM detection) work and are tested. The Logger/Generator UI and the WebGL preview are still in progress.

## Layout

```
backend/    FastAPI media service wrapping ffmpeg (slicing, waveform, export compiler)
frontend/   React + TypeScript + Vite UI
shared/     Fixtures shared by both test suites (timing parity)
scripts/    make_samples.py – synthetic test clips and a 128 BPM track
```

The session lives in `workspace/session.promo.json`, with proxies in `workspace/.cache/`.

## Setup

Requires Python 3.12+ and Node 20+.

```sh
# backend
python -m venv backend/.venv
backend/.venv/Scripts/pip install -r backend/requirements.txt

# frontend
cd frontend && npm install
```

**ffmpeg:** uses `$FFMPEG_PATH` if set, then a full ffmpeg build on `PATH`, then the binary bundled with `imageio-ffmpeg`. NVENC is used for the final encode when available; otherwise libx264.

## Run

```sh
# backend (port 8765)
cd backend && .venv/Scripts/python -m uvicorn promo_server.main:app --port 8765

# frontend dev server (port 5173, proxies /api and /media to the backend)
cd frontend && npm run dev
```

Optional sample media: `backend/.venv/Scripts/python scripts/make_samples.py`

## Tests

```sh
cd backend && .venv/Scripts/python -m pytest   # e2e export test needs the samples
cd frontend && npm test
```

If you change the timing math intentionally, regenerate the parity fixture:
`PROMO_WRITE_FIXTURE=1 pytest tests/test_parity.py`

## Environment variables

| Variable | Purpose |
| --- | --- |
| `PROMO_WORKSPACE` | Workspace folder (default `./workspace`) |
| `FFMPEG_PATH` / `FFPROBE_PATH` | Override the ffmpeg/ffprobe binaries |
| `PROMO_DISABLE_NVENC=1` | Force libx264 |
| `PROMO_KEEP_SEGMENTS=1` | Keep intermediate export segments for debugging |
| `PROMO_BACKEND` | Backend URL for the Vite proxy (default `http://127.0.0.1:8765`) |
