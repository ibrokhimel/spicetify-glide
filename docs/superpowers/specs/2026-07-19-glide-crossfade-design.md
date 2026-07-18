# Glide Crossfade Redesign

## Goal

Glide must provide a fixed-duration transition between Spotify tracks while remaining a self-contained Spicetify extension. It should use Spotify's genuine two-stream crossfade whenever the active Spotify client supports it. When true overlap is unavailable, it should fall back to a controlled fade-out, track change, and fade-in without leaving the player's volume altered.

The same transition policy applies when a track ends automatically and when the listener presses Next.

## User Experience

The settings modal retains the compact appearance of the supplied reference:

- rounded dark panel;
- lightning icon and Glide title;
- green duration value;
- 1–15 second duration slider;
- "Seamless transition timing" helper text;
- Enable Glide toggle;
- a small transition-status line.

The status line has exactly three user-facing states:

- `Native crossfade` when Spotify's native capability is configured and verified;
- `Fallback fade` when Glide must use sequential volume ramps;
- `Checking Spotify…` while capability detection is incomplete.

The previous Smart Gapless option is removed. The selected duration applies consistently to ordinary music tracks.

## Transition Architecture

Glide uses a transition controller with three runtime states:

1. `idle`: no transition is active;
2. `native`: Spotify's native crossfade is configured and verified;
3. `fallback`: Glide is running, or is prepared to run, sequential volume ramps.

Native mode is the preferred path. Glide configures Spotify's crossfade setting and duration through the supported runtime APIs exposed by the active client. It then verifies the effective setting through a readable preference or player state when such a read path exists. A successful setter call alone is not proof that native mode is active.

Glide does not call `Player.next()` before the natural end of a track in native mode. Spotify must be allowed to enter its own crossfade window. This removes the existing implementation's incorrect assumption that an early `next()` command necessarily preserves the outgoing stream.

Fallback mode cannot create two protected Spotify audio streams. It instead applies an equal-power-shaped fade-out to the current player volume, advances playback once, and applies an equal-power-shaped fade-in to the new track. The user's volume at the start of the operation is captured and restored exactly at completion or cancellation.

Spotify controls the mixing curve during native overlap. Glide guarantees its equal-power curve only for fallback volume ramps.

## Capability Detection

At startup, after a relevant setting change, and after a playback-device change, Glide probes native crossfade capability. Automatic crossfade capability and manual-skip crossfade capability are tracked separately because a Spotify build may support the former without applying it to explicit Next commands.

The probe:

1. attempts the known Spicetify/Spotify preference APIs in a defined order;
2. reads back the crossfade enabled state and duration where the active client exposes them;
3. selects native automatic mode only when the effective setting is positively verified;
4. selects native manual mode only when the active player API explicitly reports support for crossfaded skip/transition commands;
5. otherwise selects fallback mode for the unverified transition type.

Private APIs may differ between Spotify releases. Each probe adapter is isolated so a failing or missing adapter does not prevent later adapters from running. Probe failures are logged once per probe cycle rather than displayed for every track.

If the client exposes setters but no trustworthy read path, Glide selects fallback mode. A generic `Player.next()` method is not evidence of native manual-crossfade support. This favors predictable behavior over claiming an overlap that may not occur.

## Automatic Transitions

In native mode, Glide does not schedule an early skip or manipulate volume. The configured Spotify engine owns the automatic transition during the last selected number of seconds.

In fallback mode, Glide monitors playback progress. When the remaining duration first becomes less than or equal to the selected duration:

1. it captures the current track identity and user volume;
2. it fades the current track from the captured volume to silence during the first half of the selected duration;
3. it advances exactly once;
4. after the new track is confirmed, it fades from silence to the captured volume during the second half.

The complete fallback operation therefore lasts the selected duration. It does not claim to provide audio overlap.

## Manual Next

When the listener requests Next:

- Verified native manual mode passes the request to Spotify's explicit crossfaded transition path, which owns the overlap.
- Fallback mode prevents the immediate skip, performs the same equal-power fallback sequence, and advances exactly once at its midpoint.

Only one transition may own playback and volume at a time. A second Next request during a fallback cancels the ramps, advances promptly once, restores the captured volume on the resulting track, and returns the controller to `idle`.

If the active Spotify build does not expose a safe interception point for every Next entry point or keyboard shortcut, Glide intercepts the Spicetify Player call and visible player control where possible. Uninterceptable requests retain Spotify's normal behavior and must not corrupt controller state.

## Equal-Power Fallback Curve

Let normalized ramp progress be `t` from 0 to 1 and the captured user volume be `V`.

- Fade-out gain: `V × cos(t × π/2)`
- Fade-in gain: `V × sin(t × π/2)`

Animation uses a monotonic clock and recalculates gain from elapsed time rather than accumulating fixed steps. This prevents timer jitter from changing the total duration. Volume writes are clamped to the valid player range.

## Cancellation and Recovery

The active fallback is cancelled when the listener pauses, seeks outside the expected progression, changes playback device, disables Glide, or initiates a conflicting transition.

Cancellation:

1. invalidates outstanding animation callbacks and song-change handlers owned by the transition;
2. restores the captured user volume if the player is still accessible;
3. clears transition state;
4. never issues an additional track change unless cancellation was caused by a second Next request.

Song-change events caused by fallback are distinguished from unrelated song changes with a transition token and expected source/target state.

Disabling Glide also stops progress monitoring and manual interception and leaves normal Spotify playback intact.

## Bypass Conditions

Custom automatic fallback is bypassed for:

- advertisements;
- podcasts and episodes;
- local or otherwise unsupported files;
- unplayable queue entries;
- missing or invalid duration/progress data;
- tracks shorter than twice the selected duration.

When bypassed, Spotify handles playback normally. Native crossfade settings may still affect formats Spotify itself supports.

## Persistence

Glide persists:

- enabled state;
- selected duration from 1 through 15 seconds.

Legacy early-start and separate crossfade-duration values are migrated to the single duration setting. Smart Gapless storage may be ignored; it is not shown or used by the redesigned controller.

## Code Organization

The extension remains distributable as `glide.js`, but its internal sections have clear responsibilities:

- settings and migration;
- native-capability adapters;
- transition controller;
- progress eligibility and monitoring;
- manual Next interception;
- modal UI and status rendering;
- initialization and cleanup.

Each capability adapter returns a consistent verified/unavailable result. The transition controller is the only component permitted to own volume ramps or transition cancellation.

## Verification

Automated tests use mocked Spicetify APIs and fake time to cover:

- settings migration and persistence;
- positive and negative native-capability verification;
- absence of early `next()` in native automatic playback;
- fallback threshold and midpoint timing;
- equal-power curve values at the start, midpoint, and end;
- exactly one advance per completed fallback;
- manual Next in native and fallback modes;
- a repeated Next during fallback;
- cancellation on pause, seek, disable, device change, and unrelated song change;
- restoration of the captured user volume;
- all bypass conditions;
- UI duration, toggle, and status rendering.

A manual Spotify checklist verifies the current desktop client because private Spotify APIs and manual Next behavior cannot be proven completely by mocks.

## Acceptance Criteria

The redesign is accepted when:

1. the extension never calls Next early during native automatic playback;
2. verified native capability displays `Native crossfade` and delegates overlap to Spotify;
3. unverified capability displays `Fallback fade` and produces a duration-correct equal-power sequential transition;
4. automatic and manual transitions both honor the selected duration within timer tolerance;
5. cancellation and errors never leave the user's volume reduced or elevated;
6. repeated transition requests never produce duplicate unintended skips;
7. the modal matches the supplied compact Glide design and contains no Smart Gapless control;
8. unsupported content continues through Spotify's normal playback behavior.
