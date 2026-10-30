# promoEditor

Local-first tool for cutting beat-synced event promo videos (9:16, 1080x1920).

- **Logger** – scrub raw footage and tag moments with hotkeys (`1`–`4` energy anchors from vibe to peak, hold `0` for a breather range). Each mark is sliced losslessly in the background and gets a dominant-colour tag. For big folders: duplicate files are detected and hidden, a 20-tile grid of looping previews (`V`), and **Auto-harvest**, which picks ~35 good moments across all files without watching them. Harvest v2 (default) checks each candidate frame by frame: it ignores camera shake, light flicker and cuts inside the source, anchors on the peak of the action, puts the focus point on it and rates sharpness (soft clips stay off full screen). v1, the quick keyframe-only pick, is still selectable for comparison.
- **Generator** – set BPM and drop, lay out zones (intro, stutter build, breather, drop), and roll a sequence of Beat Cards from the clip pool (no repeated source file within 4 cards, no back-to-back colours). Lock cards you like, reroll the rest, re-tier clips with `+`/`−` or the clip library, add event text (title, hook words, dates) in one of three styles, preview in real time, export to MP4.

> **Status:** both tools run end-to-end on the sample media (log → roll → preview → export). Not yet tested with real camera footage.

- **✨ Auto promo** – pick a song, a clips folder, a length (15–60 s) and a video type; it harvests the clips, finds the BPM and the drop, builds the structure, styles it, rolls the Beat Cards and can export the MP4 in one go.

## Layout

```
backend/    FastAPI media service wrapping ffmpeg (slicing, waveform, export compiler)
frontend/   React + TypeScript + Vite UI
shared/     Fixtures shared by both test suites (timing parity)
scripts/    make_samples.py – synthetic test clips and a 128 BPM track
```

Projects live under `workspace/`: the original workspace is the "Default" project and every other project is a folder in `workspace/projects/<name>/`, each with its own `session.promo.json`, `.cache/` (slices) and `exports/`. Switch, create or "save as" from the 📁 menu in the header.

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
```

Then either open http://127.0.0.1:8765 (serves `frontend/dist` after `npm run build`; restart the backend after building), or for development run `npm run dev` in `frontend/` and open http://localhost:5173 (proxies `/api` and `/media` to the backend).

Use one browser tab per session: each tab autosaves the whole session, so two tabs overwrite each other.

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
