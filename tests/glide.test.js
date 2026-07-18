const test = require("node:test");
const assert = require("node:assert/strict");

const { GlideCore } = require("../glide.js");

test("clamps duration to the supported 1-15 second range", () => {
    assert.equal(GlideCore.clampDuration(0), 1);
    assert.equal(GlideCore.clampDuration(7.5), 7.5);
    assert.equal(GlideCore.clampDuration(20), 15);
});

test("equal-power fade-out has correct endpoints and midpoint", () => {
    assert.equal(GlideCore.fadeOutGain(0), 1);
    assert.ok(Math.abs(GlideCore.fadeOutGain(0.5) - Math.SQRT1_2) < 1e-12);
    assert.ok(Math.abs(GlideCore.fadeOutGain(1)) < 1e-12);
});

test("equal-power fade-in has correct endpoints and midpoint", () => {
    assert.equal(GlideCore.fadeInGain(0), 0);
    assert.ok(Math.abs(GlideCore.fadeInGain(0.5) - Math.SQRT1_2) < 1e-12);
    assert.equal(GlideCore.fadeInGain(1), 1);
});

function memoryStorage(values = {}) {
    const data = new Map(Object.entries(values));
    return {
        get: (key) => data.has(key) ? data.get(key) : null,
        set: (key, value) => data.set(key, value),
        value: (key) => data.get(key),
    };
}

test("loads and persists the single duration setting", () => {
    const storage = memoryStorage({
        "glide:enabled": "false",
        "glide:duration": "8",
        "glide:earlyStart": "3",
    });

    assert.deepEqual(GlideCore.loadSettings(storage), {
        enabled: false,
        durationSec: 8,
    });
});

test("migrates the legacy early-start duration", () => {
    const storage = memoryStorage({ "glide:earlyStart": "6" });

    assert.deepEqual(GlideCore.loadSettings(storage), {
        enabled: true,
        durationSec: 6,
    });
    assert.equal(storage.value("glide:duration"), "6");
});

test("verifies native automatic crossfade by reading back settings", async () => {
    const values = new Map();
    const platform = {
        ConfigAPI: {
            setAccountSetting: async (key, value) => values.set(key, value),
            getAccountSetting: async (key) => values.get(key),
        },
        PlayerAPI: {
            crossfadeToNext() {},
        },
    };

    assert.deepEqual(
        await GlideCore.probeNativeCapability(platform, 7),
        { automatic: true, manual: true },
    );
});

test("does not trust native setters without a read path", async () => {
    const platform = {
        ConfigAPI: {
            async setAccountSetting() {},
        },
        PlayerAPI: {
            next() {},
        },
    };

    assert.deepEqual(
        await GlideCore.probeNativeCapability(platform, 5),
        { automatic: false, manual: false },
    );
});

test("fallback fades out, advances once, and fades in to the captured volume", async () => {
    let time = 0;
    let advances = 0;
    const volumes = [];
    const controller = GlideCore.createTransitionController({
        durationMs: () => 1000,
        now: () => time,
        requestFrame: (callback) => {
            time += 250;
            queueMicrotask(callback);
        },
        getVolume: () => 0.8,
        setVolume: (volume) => volumes.push(volume),
        next: async () => { advances += 1; },
        waitForSongChange: async () => {},
    });

    await controller.startFallback("automatic");

    assert.equal(advances, 1);
    assert.equal(controller.state(), "idle");
    assert.ok(Math.abs(volumes[0] - 0.8 * Math.SQRT1_2) < 1e-12);
    assert.ok(Math.abs(volumes.at(-1) - 0.8) < 1e-12);
});

test("cancelling fallback restores volume and prevents an advance", async () => {
    const frames = [];
    const volumes = [];
    const controller = GlideCore.createTransitionController({
        durationMs: () => 1000,
        now: () => 0,
        requestFrame: (callback) => frames.push(callback),
        getVolume: () => 0.6,
        setVolume: (volume) => volumes.push(volume),
        next: async () => assert.fail("cancelled transition must not advance"),
        waitForSongChange: async () => {},
    });

    const transition = controller.startFallback("automatic");
    await controller.cancel("pause");
    await transition;

    assert.equal(controller.state(), "idle");
    assert.equal(volumes.at(-1), 0.6);
});

test("a repeated Next cancels fallback and advances exactly once", async () => {
    const frames = [];
    let advances = 0;
    const controller = GlideCore.createTransitionController({
        durationMs: () => 1000,
        now: () => 0,
        requestFrame: (callback) => frames.push(callback),
        getVolume: () => 0.7,
        setVolume() {},
        next: async () => { advances += 1; },
        waitForSongChange: async () => {},
    });

    const transition = controller.startFallback("manual");
    await controller.cancel("repeated-next", { advance: true });
    await transition;

    assert.equal(advances, 1);
    assert.equal(controller.state(), "idle");
});

test("fallback restores volume when advancing fails", async () => {
    let time = 0;
    const volumes = [];
    const controller = GlideCore.createTransitionController({
        durationMs: () => 1000,
        now: () => time,
        requestFrame: (callback) => {
            time += 500;
            queueMicrotask(callback);
        },
        getVolume: () => 0.4,
        setVolume: (volume) => volumes.push(volume),
        next: async () => { throw new Error("advance failed"); },
        waitForSongChange: async () => {},
    });

    await assert.rejects(controller.startFallback("automatic"), /advance failed/);
    assert.equal(volumes.at(-1), 0.4);
    assert.equal(controller.state(), "idle");
});

test("fallback subscribes to song change before advancing", async () => {
    let time = 0;
    let subscribed = false;
    const controller = GlideCore.createTransitionController({
        durationMs: () => 1000,
        now: () => time,
        requestFrame: (callback) => {
            time += 500;
            queueMicrotask(callback);
        },
        getVolume: () => 0.5,
        setVolume() {},
        next: async () => assert.equal(subscribed, true),
        waitForSongChange: async () => { subscribed = true; },
    });

    await controller.startFallback("automatic");
});

test("fallback eligibility accepts ordinary music at the threshold", () => {
    const item = { type: "track", uri: "spotify:track:123", isLocal: false };
    assert.equal(GlideCore.isFallbackEligible(item, 5000, 175000, 180000), true);
});

test("fallback eligibility rejects unsupported and short content", () => {
    const cases = [
        { type: "episode", uri: "spotify:episode:1" },
        { type: "ad", uri: "spotify:ad:1" },
        { type: "track", uri: "spotify:local:artist:album:song" },
        { type: "track", uri: "spotify:track:1", isLocal: true },
    ];
    for (const item of cases) {
        assert.equal(GlideCore.isFallbackEligible(item, 5000, 175000, 180000), false);
    }
    assert.equal(
        GlideCore.isFallbackEligible(
            { type: "track", uri: "spotify:track:short" },
            5000,
            4000,
            9000,
        ),
        false,
    );
});

test("native automatic mode never starts fallback", async () => {
    let starts = 0;
    const started = await GlideCore.maybeStartAutomatic({
        enabled: true,
        nativeAutomatic: true,
        item: { type: "track", uri: "spotify:track:1" },
        durationMs: 5000,
        progressMs: 175000,
        totalMs: 180000,
        startFallback: async () => { starts += 1; },
    });
    assert.equal(started, false);
    assert.equal(starts, 0);
});

test("manual Next uses only an explicitly verified native transition", async () => {
    let nativeCalls = 0;
    let fallbackCalls = 0;
    await GlideCore.requestNext({
        nativeManual: true,
        crossfadeToNext: async () => { nativeCalls += 1; },
        startFallback: async () => { fallbackCalls += 1; },
    });
    assert.equal(nativeCalls, 1);
    assert.equal(fallbackCalls, 0);

    await GlideCore.requestNext({
        nativeManual: false,
        crossfadeToNext: async () => { nativeCalls += 1; },
        startFallback: async () => { fallbackCalls += 1; },
    });
    assert.equal(nativeCalls, 1);
    assert.equal(fallbackCalls, 1);
});

test("settings markup exposes the approved controls and status", () => {
    const markup = GlideCore.renderSettingsMarkup({
        enabled: true,
        durationSec: 5,
        status: "Native crossfade",
    });

    assert.match(markup, /Glide/);
    assert.match(markup, /5s/);
    assert.match(markup, /min="1"/);
    assert.match(markup, /max="15"/);
    assert.match(markup, /Seamless transition timing/);
    assert.match(markup, /Enable Glide/);
    assert.match(markup, /Native crossfade/);
    assert.doesNotMatch(markup, /Smart Gapless/);
});
