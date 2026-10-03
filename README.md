# There and Back Again

**Hold to record, let go to hear it backwards.** A reverse-audio toy for the
phone browser: sing, play or say something, release the button, and it plays
back reversed straight away. Layer up to three reversed takes.

Live: <https://adamborecki.github.io/there-and-back/>

Runs entirely in the browser (iOS Safari included). No backend, no uploads.

---

## Using it

| | Hold mode (default) | Tap on / off mode |
|---|---|---|
| Record | press and hold | tap |
| Hear it backwards | let go | tap again |
| Replay / stop | quick tap, or ▶ | ▶ |
| Keyboard | hold Space | Space toggles |

- **Tracks 1–3**: pick a track, then record into it; all filled tracks play
  together. Recording over a take replaces it, with an **Undo** button for
  12 seconds. The × deletes a track after asking (with "Save it first").
- **Loop** (left button) repeats playback.
- **Save** (on the waveform) exports the selected track as a WAV, through the
  share sheet on iPhone (Save to Files, AirDrop, Messages…) or as a download.
- **Takes are kept on this device** (IndexedDB) and come back after a reload.
  iOS Safari can clear a site's storage after ~7 days without a visit, so use
  Save for anything you want to keep.
- **Settings**: record-button mode, volume (up to 300%), auto-maximize,
  speed, fade in / out, microphone, and output device (Chrome only).

## How it works (and what changed from the first version)

The first version lived in
[misc-music-webapps](https://github.com/adamborecki/misc-music-webapps) and
was too quiet on iPhone. It also recorded with `MediaRecorder`, which meant an
encode + decode pause after you let go. This version fixes both:

- **Raw capture.** An AudioWorklet (`src/capture-worklet.js`) streams the mic
  as raw samples, so on release the take is already a `Float32Array`. It's
  reversed and playing within a few milliseconds.
- **No browser processing.** Echo cancellation, noise suppression and
  auto-gain are all requested *off* (the settings pills show whether the
  browser honoured it).
- **Auto-maximize.** Each take is boosted toward a loud RMS target without
  letting its peaks clip (the approach that worked in
  [me-again](https://github.com/adamborecki/me-again)).
- **Loud output chain.** Playback → volume → +9 dB drive → limiter → soft
  clipper. Loud on a phone speaker, without digital overs.
- **Thud trimming.** 30 ms is cut from each end of a take (the tap on the
  screen), and short default fades smooth the edges.

## Running locally

Plain HTML + ES modules, no build step. Serve over http(s) (mic access and
AudioWorklets don't work from `file://`):

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

## Deploying

GitHub Pages via the Actions workflow in `.github/workflows/static.yml`:
every push to `main` goes live at <https://adamborecki.github.io/there-and-back/>.

## Project structure

```
index.html               markup
src/app.js               UI, record-button logic, waveform, settings
src/audio.js             AudioContext, mic, capture, maximize, reverse, playback
src/capture-worklet.js   AudioWorklet that streams raw mic samples
src/store.js             keeps the tracks on this device (IndexedDB)
src/wav.js               WAV encoding + share / download
src/styles.css           light/dark theme, mobile-first
```

## Testing checklist

- [ ] iOS Safari: Tap to start → mic prompt → meter moves
- [ ] Hold, sing, let go → reversed playback starts immediately and is loud
- [ ] Quick tap replays; quick tap while playing stops
- [ ] Long-press doesn't select text or open a callout
- [ ] Tap on / off mode works; ▶ replays
- [ ] Three tracks layer; × asks before deleting
- [ ] Recording over a take shows Undo; Undo brings the old take back
- [ ] Loop repeats until stopped
- [ ] Save opens the share sheet on iPhone; the WAV plays back reversed
- [ ] Reload: takes come back; × then reload: that take stays gone
- [ ] Backgrounding mid-take stops cleanly; returning still works
