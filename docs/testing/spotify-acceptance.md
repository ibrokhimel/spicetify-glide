# Spotify Desktop Acceptance Checklist

## Environment

- Date: 2026-07-19
- Spicetify: 2.44.0
- Spotify desktop executable: 1.2.94.583
- Automated runtime: Node.js built-in test runner

## Automated Results

| Check | Result | Evidence |
|---|---|---|
| Duration clamps to 1–15 seconds | Pass | `tests/glide.test.js` |
| Legacy duration migrates | Pass | `tests/glide.test.js` |
| Native mode requires setting read-back | Pass | `tests/glide.test.js` |
| Generic Next is not accepted as native manual crossfade | Pass | `tests/glide.test.js` |
| Native automatic mode never starts fallback | Pass | `tests/glide.test.js` |
| Equal-power endpoints and midpoint | Pass | `tests/glide.test.js` |
| Fallback advances exactly once | Pass | `tests/glide.test.js` |
| Repeated Next cancels and advances once | Pass | `tests/glide.test.js` |
| Pause/disable cancellation can restore captured volume | Pass | controller cancellation tests |
| Unsupported and short content bypasses fallback | Pass | `tests/glide.test.js` |
| Approved settings controls and status copy render | Pass | `tests/glide.test.js` |
| JavaScript parses successfully | Pass | `node --check glide.js` |

## Spotify Listening Checks

These checks require installing the development build into Spotify and listening to active playback. They are intentionally marked **Not run** because this implementation session did not modify the user's installed Spotify client.

| Check | Result | Procedure |
|---|---|---|
| Extension loads | Not run | Install `glide.js`, apply Spicetify, restart Spotify, and confirm the lightning button appears. |
| Settings persistence | Not run | Select 7 seconds, reopen the modal, restart Spotify, and confirm 7 seconds remains selected. |
| Native status | Not run | On a client exposing readable crossfade settings, confirm `Native crossfade` appears. |
| Native automatic transition | Not run | Play two ordinary queued tracks and confirm Song B overlaps during Song A's final selected seconds without an early skip. |
| Manual native Next | Not run | Press the visible Next control and a keyboard/media-key Next entry point; record which paths Spotify crossfades. |
| Fallback status | Not run | Use a client/device without a verifiable read path and confirm `Fallback fade` appears. |
| Automatic fallback | Not run | Confirm the outgoing half-fade, one track advance, and incoming half-fade complete in the selected duration. |
| Repeated Next | Not run | Press Next twice during fallback and confirm playback advances promptly without a duplicate later skip. |
| Pause cancellation | Not run | Pause during both halves and confirm the original volume is restored. |
| Seek cancellation | Not run | Seek backward during fallback and confirm volume and controller state recover. |
| Disable cancellation | Not run | Disable Glide during fallback and confirm original volume and ordinary playback return. |
| Device switch | Not run | Switch Spotify Connect devices during fallback and confirm no stale volume writes continue. |
| Short track bypass | Not run | Queue a track shorter than twice the selected duration and confirm Spotify handles it normally. |
| Episode/local-file bypass | Not run | Play an episode and a local file and confirm Glide does not start custom automatic fallback. |

## Release Decision

Automated acceptance passes. Audio behavior remains pending an installed Spotify listening pass because protected-stream overlap and private client API availability cannot be established by mocks.
