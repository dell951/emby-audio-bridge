# Emby Audio Bridge

Independent experimental Chrome extension. Keeps Emby's video element and controls; decodes AC3/EAC3 locally using FFmpeg WASM and plays PCM through Web Audio. No server administration is required.

## Status

Prototype loaded in Chrome and tested in the logged-in Emby session on 2026-11-08. EAC3 and DTS decoding, active Web Audio output, pause silence, seek recovery and navigation cleanup were observed. Subjective lip-sync and actual progress-bar dragging are not fully verified. Do not run alongside AbsolutePlayer: it replaces the video this extension needs to observe. No assertion of full-movie continuous synchronization is made yet.

Current constraints: configured same-origin `.mkv` URLs, HTTP Range support, first audio stream only. Emby audio-track switching is not implemented. Blob/MSE sources and cross-origin redirects are not supported. Chrome autoplay policy may suspend the hidden audio context. Actual MKV timestamp accuracy, decoder throughput and gap-free playback at chunk boundaries require browser validation. The synchronization-first policy pauses video while audio buffers.

## Development

Prerequisite: Node.js 18+; no npm dependencies.

From this directory:

- `npm test` — playback-clock unit tests.
- `npm run check` — JavaScript syntax checks.

Load this directory as an unpacked extension at `chrome://extensions`. Open the extension options and add each Emby server, then grant the host permission when Chrome prompts. The extension registers its content script only for configured hosts and restores registrations when the options page opens. Permission patterns are optional in the manifest; the page asks for the selected scheme and hostname instead of requesting access to all sites. Chrome host matching ignores ports, so a grant covers all ports on that hostname for the selected scheme. Credentials are sent only in requests to the configured Emby origin and are not intentionally logged.

## Structure

`src/content.js` observes the original video. A hidden extension frame owns Web Audio and the decoder worker. `src/audio.js` uses the video clock as authority, cancels the worker on seeks, and decodes bounded audio chunks. `src/clock.js` contains clock arithmetic. Worker termination cancels stale decoding; frame removal stops audio. A heartbeat silences audio if video state updates stop.

## Validation still required

Test first playback, long forward/backward seeks, repeated scrubbing, pause/resume, buffering, volume/mute, playback speed, stop/navigation and subsequent movie playback. Confirm the original subtitle and progress controls remain functional. Verify memory and network use over a full movie. The current chunk scheduler is experimental and may have boundary gaps.

## Third-party code

`vendor/core/ffmpeg-core.*` is the existing FFmpeg WASM distribution copied from the previous local AbsolutePlayer package. `src/decode-worker.js` is adapted from AbsolutePlayer's range-backed worker; its upstream license is preserved at `vendor/AbsolutePlayer-LICENSE`. FFmpeg distribution licensing/build provenance must be checked before redistribution.

### Follow-up validation

The extension now streams decoded PCM from the worker instead of waiting for a whole output file. Adjacent buffers are scheduled against a shared Web Audio clock. Six clock/scheduling regression tests pass, including cancelling future scheduled audio on pause and replacing stale audio on seek. Idle decoders retain their WASM instance and Range cache; busy decoders are terminated on seek.

Chrome testing observed native progress-slider increment moving video from 1:36 to 2:18, subsequent EAC3 audio recovery, and recovery after a long jump to 10:00. Continuous eight-second decoding batches were observed around 1.3–2.1 seconds after initialization; initial/seek network latency still sometimes caused silence and is unresolved. Pause diagnostics reported no scheduled audio. Navigating back to movie details removed both the audio iframe and video element without requiring a refresh. The latest event-listener and Range-validation changes have been reloaded into Chrome; no full-movie or subjective lip-sync acceptance test has been completed.

### Audio-only endpoint feasibility

Authenticated browser tests on the current video item found embedded EAC3 tracks, with no external audio stream in PlaybackInfo. `/Audio/{item}/stream.aac` and EAC3/MKA stream-copy variants all returned HTTP 400 with `User does not have audio transcoding permission.` Copy tests omitted channel/bitrate conversion requests and enabled automatic stream copy, but were still rejected. Consequently, independent server-side audio retrieval is not an available path for this account through these tested endpoints. `Static=true` serves the original file and must not be treated as extracting audio from an MKV. Do not implement a cache workflow assuming an audio-only URL is available.

### Sliding audio cache

The decoder now retains up to 180 seconds behind the video clock and targets 30 seconds of contiguous forward audio. Decoded PCM has a 96 MiB cache budget; farthest chunks are evicted first. This budget excludes FFmpeg memory, network cache and scheduled Web Audio nodes. Seeks preserve cached audio while invalidating old decoding work. Contiguous coverage is computed across adjacent chunks rather than assuming the furthest chunk means all intermediate audio is present. Nine tests pass. This cache revision has not yet been reloaded or verified in Chrome; network misses, buffering and subjective synchronization still require acceptance testing.

### Video waits for audio: browser observations

Latest build loaded in Chrome. Video automatically paused at 1235.4144 seconds while no audio was cached; repeated observations showed the same position. Once PCM arrived, video advanced to 1243.7132 and audio diagnostics showed active output. Video paused again at 1244.0633 when decoding fell behind. Seeking to cached 1238 seconds and requesting play recovered active audio at 1240.0576. Explicit pause at 1242.7389 stopped scheduled audio; after ten seconds the video remained paused at the same position. Navigating to details removed all audio frames and video elements. Initial/random-read wait was tens of seconds and repeated buffering persists, so smooth playback is not accepted. Tests used the actual video object's controls through DevTools; this round did not verify mouse dragging the progress bar, subjective lip-sync, or cancelling playback intent while the video is already automatically paused for audio.

### Synchronization-first performance tuning

Continuous decode jobs now span 24 seconds (PCM still streams during the job). Rebuffering waits for six seconds of audio at normal speed, scaled with playback rate, and pauses before exhausting the audio. Range request durations are recorded; job time minus synchronous Range request time is reported as other processing, not an isolated CPU benchmark. Thirteen tests pass.

Chrome observations after reload: at video 1259.3589, audio output was active and cached audio extended to approximately 1293; the latest job took 4889.5 ms, including 4741.9 ms of Range reads and 147.6 ms of other processing. At 1281.7588, audio remained active and cache extended to approximately 1317; latest job took 5886 ms, including 5694 ms of Range reads and 192 ms other processing. Native video was unpaused and advancing at both observations. These short observations show improved forward reserve, not full-movie acceptance or proof of subjective lip-sync. Playback was left running for user review. Synchronization remains prioritized over uninterrupted video when audio is unavailable.

### DTS support (v0.2.0)

DTS now shares the AC3/EAC3 buffering and synchronization path. The actual bundled WASM decoded one second from the local DTS fixture into 384000 bytes of 48 kHz stereo float PCM (exit 0). Fifteen tests and syntax checks passed. Chrome testing on the user's DTS-HD MA 5.1 / 96 kHz MKV source reported codec dts, decoding active, 40 cached PCM chunks, and scheduled audio output. The user confirmed hearing sound. This verifies playback, not lossless HD-layer fidelity or 5.1 passthrough; output remains 48 kHz stereo.

### Generic Emby server configuration (v0.4.0)

Removed the fixed site match and required host permission from `manifest.json`. The options page now requests optional host access after the user enters an Emby URL, stores the selected site patterns, and registers `src/content.js` dynamically with `chrome.scripting`. Removing a server unregisters its script and revokes its host permission. Persisted registrations are restored when options are opened. URL paths and ports are normalized to scheme plus hostname because Chrome match patterns apply to all ports and paths on a hostname. The audio iframe validates messages against the active media URL's origin rather than a compile-time site constant. The extension CSP permits HTTP(S) connections; actual network access remains gated by per-host grants. The environment check now reports configured server permission and can restore its script registration.

Added extension artwork as SVG source plus 16/32/48/128 px PNGs. Static checks verified JavaScript syntax, manifest JSON, absence of static `content_scripts`, and diff whitespace. This generic configuration has not yet been acceptance-tested in Chrome against a newly configured second Emby host.
