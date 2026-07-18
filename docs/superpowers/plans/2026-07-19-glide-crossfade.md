# Glide Crossfade Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Glide's unreliable early-skip behavior with verified Spotify-native crossfade plus a safe equal-power sequential fallback for automatic and manual transitions.

**Architecture:** `glide.js` remains the installable Spicetify extension and exposes a small set of pure helpers under Node for tests. A single transition controller owns timing, cancellation, track advancement, and volume restoration; isolated capability adapters decide native versus fallback behavior.

**Tech Stack:** Browser JavaScript, Spicetify runtime APIs, Node.js built-in test runner, Git/GitHub CLI.

## Global Constraints

- Remain a self-contained Spicetify extension whose manifest entry point is `glide.js`.
- Use genuine Spotify crossfade only when the active client positively verifies the relevant capability.
- Never call Next early during native automatic playback.
- Guarantee the equal-power curve only for sequential fallback ramps.
- Use the selected fixed duration, from 1 through 15 seconds, for automatic and manual transitions.
- Restore the listener's captured volume after every completion, cancellation, or error.
- Preserve the compact dark settings UI supplied by the user and remove Smart Gapless.
- Bypass custom automatic fallback for unsupported content and tracks shorter than twice the duration.

---

## File Map

- `glide.js`: installable extension; pure math/settings helpers, capability adapters, transition controller, progress monitor, Next interception, UI, and lifecycle.
- `tests/glide.test.js`: Node tests with mocked player APIs and fake animation time.
- `package.json`: dependency-free test command and package metadata.
- `README.md`: accurate behavior, limitations, setup, and troubleshooting.
- `manifest.json`: new release description and version.

### Task 1: Establish the test harness and pure contracts

**Files:**
- Create: `package.json`
- Create: `tests/glide.test.js`
- Modify: `glide.js`

**Interfaces:**
- Produces: `GlideCore.clampDuration(value): number`
- Produces: `GlideCore.fadeOutGain(t): number`
- Produces: `GlideCore.fadeInGain(t): number`
- Produces: `GlideCore.isFallbackEligible(item, durationMs, progressMs, totalMs): boolean`
- Produces: `GlideCore.createTransitionController(deps): TransitionController`

- [ ] **Step 1: Add a failing Node test for duration clamping and equal-power endpoints**

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const { GlideCore } = require("../glide.js");

test("clamps duration to the supported 1–15 second range", () => {
  assert.equal(GlideCore.clampDuration(0), 1);
  assert.equal(GlideCore.clampDuration(7.5), 7.5);
  assert.equal(GlideCore.clampDuration(20), 15);
});

test("equal-power helpers have correct endpoints and midpoint", () => {
  assert.equal(GlideCore.fadeOutGain(0), 1);
  assert.ok(Math.abs(GlideCore.fadeOutGain(0.5) - Math.SQRT1_2) < 1e-12);
  assert.ok(Math.abs(GlideCore.fadeOutGain(1)) < 1e-12);
  assert.equal(GlideCore.fadeInGain(0), 0);
  assert.ok(Math.abs(GlideCore.fadeInGain(0.5) - Math.SQRT1_2) < 1e-12);
  assert.equal(GlideCore.fadeInGain(1), 1);
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `node --test tests/glide.test.js`

Expected: FAIL because `GlideCore` is not exported.

- [ ] **Step 3: Add the pure helpers and a Node-safe export guard**

```js
const GlideCore = (() => {
  const clamp01 = (value) => Math.min(1, Math.max(0, Number(value) || 0));
  const clampDuration = (value) => Math.min(15, Math.max(1, Number(value) || 5));
  const fadeOutGain = (t) => Math.cos(clamp01(t) * Math.PI / 2);
  const fadeInGain = (t) => Math.sin(clamp01(t) * Math.PI / 2);
  return { clampDuration, fadeOutGain, fadeInGain };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = { GlideCore };
}
```

Guard browser initialization with `if (typeof Spicetify !== "undefined")`.

- [ ] **Step 4: Add `package.json` and run the tests**

```json
{
  "name": "spicetify-glide",
  "version": "4.0.0",
  "private": true,
  "scripts": { "test": "node --test tests/*.test.js" },
  "engines": { "node": ">=20" }
}
```

Run: `npm test`

Expected: 2 passing tests.

- [ ] **Step 5: Commit**

```bash
git add package.json tests/glide.test.js glide.js
git commit -m "test: establish crossfade core contracts"
git push
```

### Task 2: Implement settings migration and native capability verification

**Files:**
- Modify: `glide.js`
- Modify: `tests/glide.test.js`

**Interfaces:**
- Consumes: `GlideCore.clampDuration`
- Produces: `GlideCore.loadSettings(storage): { enabled: boolean, durationSec: number }`
- Produces: `GlideCore.probeNativeCapability(platform, durationSec, logger): Promise<{ automatic: boolean, manual: boolean }>`

- [ ] **Step 1: Write failing tests for legacy migration and positive/negative capability reads**

Create in-memory storage with `get`/`set`, assert the single duration prefers `glide:duration`, then legacy `glide:earlyStart`, and defaults to 5. Mock a Config API whose getter returns enabled and matching milliseconds; assert `automatic === true`. Mock setters without getters; assert both capabilities are false.

- [ ] **Step 2: Run the focused tests**

Run: `node --test --test-name-pattern="settings|capability" tests/glide.test.js`

Expected: FAIL because the new functions do not exist.

- [ ] **Step 3: Implement migration and adapter isolation**

Use storage keys `glide:enabled` and `glide:duration`. Each adapter catches its own exception. A setter result never verifies capability. Set `manual: true` only when a distinct runtime method such as `crossfadeToNext` is callable; generic `next` does not qualify.

- [ ] **Step 4: Run the focused and full suites**

Run: `npm test`

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add glide.js tests/glide.test.js
git commit -m "feat: verify native crossfade capability"
git push
```

### Task 3: Build the fallback transition controller

**Files:**
- Modify: `glide.js`
- Modify: `tests/glide.test.js`

**Interfaces:**
- Consumes: `fadeOutGain`, `fadeInGain`
- Produces: `controller.startFallback(reason): Promise<void>`
- Produces: `controller.cancel(reason, { advance?: boolean }): Promise<void>`
- Produces: `controller.state(): "idle" | "fallback"`

- [ ] **Step 1: Write failing fake-clock tests**

Mock `now`, `requestFrame`, `setVolume`, `getVolume`, `next`, and `waitForSongChange`. Assert fade-out reaches zero at half-duration, `next` is called exactly once, fade-in reaches captured volume at full duration, and cancellation restores captured volume.

- [ ] **Step 2: Run controller tests and verify failure**

Run: `node --test --test-name-pattern="fallback|cancel" tests/glide.test.js`

Expected: FAIL because `createTransitionController` is absent.

- [ ] **Step 3: Implement tokenized controller ownership**

Use a monotonically increasing token. Every animation callback checks the token before writing volume. Compute progress from the monotonic clock. The midpoint advances once and waits for the expected song change before fade-in. Put volume restoration and state reset in `finally`.

- [ ] **Step 4: Add and pass repeated-Next and error tests**

Assert a second Next invalidates the first transition, produces only one prompt advance after cancellation, and restores the captured volume even when `next` or song confirmation rejects.

Run: `npm test`

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add glide.js tests/glide.test.js
git commit -m "feat: add equal-power fallback controller"
git push
```

### Task 4: Replace early-skip monitoring and integrate manual Next

**Files:**
- Modify: `glide.js`
- Modify: `tests/glide.test.js`

**Interfaces:**
- Consumes: capability result and transition controller
- Produces: `GlideCore.isFallbackEligible(...)`
- Produces: runtime `checkProgress()`, `requestNext()`, and cancellation handlers

- [ ] **Step 1: Write failing eligibility and integration tests**

Assert ordinary tracks trigger fallback at the duration threshold; native automatic mode never calls Next from progress monitoring; episodes, ads, local files, invalid durations, and tracks shorter than twice the duration are bypassed.

- [ ] **Step 2: Run tests and verify failure**

Run: `node --test --test-name-pattern="eligible|automatic|manual" tests/glide.test.js`

Expected: FAIL on missing behavior.

- [ ] **Step 3: Replace `triggerEarlySkip` with mode-aware orchestration**

Native automatic mode performs no threshold action. Fallback mode starts once per track. Manual requests call an explicit verified native transition method or start fallback. Register pause, seek, song change, and device-change cancellation without allowing unrelated events to double-advance.

- [ ] **Step 4: Run the full suite**

Run: `npm test`

Expected: all tests pass and no test observes an early Next call in native automatic mode.

- [ ] **Step 5: Commit**

```bash
git add glide.js tests/glide.test.js
git commit -m "feat: orchestrate automatic and manual transitions"
git push
```

### Task 5: Rebuild the approved settings UI

**Files:**
- Modify: `glide.js`
- Modify: `tests/glide.test.js`

**Interfaces:**
- Consumes: settings, capability result, transition controller
- Produces: status copy `Native crossfade`, `Fallback fade`, or `Checking Spotify…`

- [ ] **Step 1: Write failing rendering-contract tests**

Extract the modal markup generator as `GlideCore.renderSettingsMarkup(model)`. Assert the duration, toggle state, exact status copy, 1–15 slider bounds, helper text, and absence of `Smart Gapless`.

- [ ] **Step 2: Run UI contract tests and verify failure**

Run: `node --test --test-name-pattern="settings markup" tests/glide.test.js`

Expected: FAIL because the renderer is absent.

- [ ] **Step 3: Implement the compact modal**

Match the supplied dark rounded panel, lightning icon, green value and slider, helper text, divider, and large toggle. Add the muted status line beneath the helper text. Slider input persists duration and reprobes capability; disabling cancels fallback and restores volume.

- [ ] **Step 4: Run tests and inspect the supplied reference beside the generated UI**

Run: `npm test`

Expected: all tests pass. Manual inspection confirms no Smart Gapless control and the requested hierarchy/copy.

- [ ] **Step 5: Commit**

```bash
git add glide.js tests/glide.test.js
git commit -m "feat: refresh Glide transition settings"
git push
```

### Task 6: Update release metadata and documentation

**Files:**
- Modify: `README.md`
- Modify: `manifest.json`
- Modify: `glide.js`

**Interfaces:**
- Produces: consistent version `4.0.0` and documentation matching runtime behavior.

- [ ] **Step 1: Update all version strings and feature descriptions**

Document verified native mode, equal-power sequential fallback, automatic/manual behavior, status meanings, supported 1–15 second duration, bypass rules, and the limitation that protected Spotify audio cannot be independently mixed by the extension.

- [ ] **Step 2: Check documentation consistency**

Run: `rg -n "3\\.2|early skip|Smart Gapless|true audio overlap" README.md manifest.json glide.js`

Expected: no stale claims except clearly labeled historical explanation if retained.

- [ ] **Step 3: Run final automated verification**

Run: `npm test`

Expected: all tests pass.

- [ ] **Step 4: Check syntax and working-tree scope**

Run: `node --check glide.js`

Expected: no output and exit code 0.

Run: `git status --short`

Expected: only README, manifest, and version changes for this task.

- [ ] **Step 5: Commit and push**

```bash
git add README.md manifest.json glide.js
git commit -m "docs: release Glide 4.0.0"
git push
```

### Task 7: Manual Spotify acceptance check

**Files:**
- Create: `docs/testing/spotify-acceptance.md`

**Interfaces:**
- Produces: a reproducible desktop verification checklist and recorded results.

- [ ] **Step 1: Write the checklist**

Cover extension loading, settings persistence, native status, automatic transition, manual Next, fallback status, repeated Next, pause/seek cancellation, disable during transition, device switch, short tracks, episodes/local files, and final volume restoration.

- [ ] **Step 2: Run checks available in the local environment**

Record each check as Pass, Fail, or Not run with the Spotify/Spicetify versions. Do not mark audio behavior Pass without listening in an active Spotify desktop client.

- [ ] **Step 3: Re-run automated verification**

Run: `npm test`

Expected: all tests pass.

- [ ] **Step 4: Commit and push**

```bash
git add docs/testing/spotify-acceptance.md
git commit -m "test: add Spotify acceptance checklist"
git push
```
