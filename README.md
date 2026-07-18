# Project Glide

Glide is a Spicetify extension for smooth, fixed-duration transitions in Spotify desktop.

## How Glide 4 works

Glide checks whether the active Spotify client can configure **and read back** its native crossfade setting.

- **Native crossfade:** Spotify owns the genuine two-track overlap. Glide configures the selected duration and does not skip the outgoing song early.
- **Fallback fade:** When native support cannot be verified, Glide uses an equal-power fade-out, advances once, and fades the next track in. This fallback is smooth but sequential; it does not claim to mix two protected Spotify streams.

Automatic track endings and manual Next requests follow the same capability-aware policy. A generic `Player.next()` method is not treated as evidence that Spotify supports crossfaded manual skips.

## Settings

Open Glide from the playbar lightning icon.

- **Glide:** fixed transition duration from 1 to 15 seconds.
- **Enable Glide:** enables or disables all Glide orchestration.
- **Status:** `Checking Spotify…`, `Native crossfade`, or `Fallback fade`.

Disabling Glide during a fallback restores the volume captured at the start of the transition.

## Supported playback

Glide's automatic fallback applies to ordinary Spotify music tracks. It safely leaves advertisements, podcasts and episodes, local files, invalid duration data, and tracks shorter than twice the selected duration to Spotify's normal playback behavior.

## Installation

1. Install and configure [Spicetify](https://spicetify.app/).
2. Copy `glide.js` to the Spicetify Extensions directory:
   - Windows: `%appdata%\spicetify\Extensions`
   - Linux/macOS: `~/.config/spicetify/Extensions`
3. Apply it:

   ```bash
   spicetify config extensions glide.js
   spicetify apply
   ```

## Development

Requires Node.js 20 or newer. The test suite has no third-party dependencies.

```bash
npm test
node --check glide.js
```

Spotify's private APIs vary by desktop release, so mocked tests are supplemented by the checklist in `docs/testing/spotify-acceptance.md`.

## Limitations

A Spicetify extension cannot independently decode and mix two protected Spotify audio streams. True overlap therefore depends on Spotify's verified native capability. Manual Next interception also depends on which player entry points the active Spotify build exposes.

## License

MIT
