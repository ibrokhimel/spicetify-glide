// NAME: Glide
// AUTHOR: Project Glide
// VERSION: 4.0.0
// DESCRIPTION: Verified native crossfade with an equal-power fallback.

/// <reference path="../cli/globals.d.ts" />

const GlideCore = (() => {
    const clamp01 = (value) => Math.min(1, Math.max(0, Number(value) || 0));
    const clampDuration = (value) => {
        const numeric = Number(value);
        return Math.min(15, Math.max(1, Number.isFinite(numeric) ? numeric : 5));
    };
    const fadeOutGain = (progress) => Math.cos(clamp01(progress) * Math.PI / 2);
    const fadeInGain = (progress) => Math.sin(clamp01(progress) * Math.PI / 2);

    const loadSettings = (storage) => {
        const enabledValue = storage.get("glide:enabled");
        const storedDuration = storage.get("glide:duration");
        const legacyDuration = storage.get("glide:earlyStart");
        const durationSec = clampDuration(storedDuration ?? legacyDuration ?? 5);
        storage.set("glide:duration", String(durationSec));
        return {
            enabled: enabledValue === null ? true : enabledValue === "true",
            durationSec,
        };
    };

    const probeNativeCapability = async (platform, durationSec, logger = console) => {
        const result = {
            automatic: false,
            manual: typeof platform?.PlayerAPI?.crossfadeToNext === "function",
        };
        const unwrap = (setting) => {
            if (setting && typeof setting === "object") {
                for (const key of ["value", "boolValue", "numberValue"]) {
                    if (key in setting) return unwrap(setting[key]);
                }
            }
            return setting;
        };
        const config = platform?.ConfigAPI;
        const durationMs = clampDuration(durationSec) * 1000;

        if (
            typeof config?.setAccountSetting === "function" &&
            typeof config?.getAccountSetting === "function"
        ) {
            try {
                await config.setAccountSetting("audio.crossfade_v2", true);
                await config.setAccountSetting("audio.crossfade.time_v2", durationMs);
                const enabled = unwrap(await config.getAccountSetting("audio.crossfade_v2"));
                const configuredDuration = unwrap(
                    await config.getAccountSetting("audio.crossfade.time_v2"),
                );
                result.automatic = enabled === true && Number(configuredDuration) === durationMs;
            } catch (error) {
                logger?.warn?.("[Glide] ConfigAPI crossfade probe failed", error);
            }
            if (result.automatic) return result;
        }

        const preferences = platform?.PlayerAPI?._prefs;
        if (
            typeof preferences?.setCrossfade === "function" &&
            typeof preferences?.getCrossfade === "function"
        ) {
            try {
                await preferences.setCrossfade(true, clampDuration(durationSec));
                const configured = await preferences.getCrossfade();
                const enabled = unwrap(configured?.enabled ?? configured?.isEnabled);
                const duration = unwrap(
                    configured?.duration ?? configured?.durationSec ?? configured?.duration_ms,
                );
                result.automatic = enabled === true &&
                    (Number(duration) === clampDuration(durationSec) ||
                        Number(duration) === durationMs);
            } catch (error) {
                logger?.warn?.("[Glide] Player preferences crossfade probe failed", error);
            }
        }

        return result;
    };

    const createLatestProbe = (probe, publish) => {
        let generation = 0;
        return async (...args) => {
            const current = ++generation;
            const result = await probe(...args);
            if (current === generation) publish(result);
            return result;
        };
    };

    const createTransitionController = (deps) => {
        let token = 0;
        let active = null;
        const reportError = (error) => deps.onError?.(error);
        const restoreVolume = (transition) => {
            try {
                deps.setVolume(transition.volume);
            } catch (error) {
                reportError(error);
            }
        };

        const animate = (transition, durationMs, gain) => new Promise((resolve, reject) => {
            const startedAt = deps.now();
            transition.settle = resolve;
            const step = () => {
                if (transition.token !== token) {
                    resolve();
                    return;
                }
                const progress = Math.min(1, Math.max(0, (deps.now() - startedAt) / durationMs));
                try {
                    deps.setVolume(transition.volume * gain(progress));
                } catch (error) {
                    transition.settle = null;
                    reject(error);
                    return;
                }
                if (progress >= 1) {
                    transition.settle = null;
                    resolve();
                    return;
                }
                deps.requestFrame(step);
            };
            deps.requestFrame(step);
        });

        const cancel = async (_reason, options = {}) => {
            const transition = active;
            if (!transition) {
                if (options.advance) await deps.next();
                return;
            }
            token += 1;
            active = null;
            const settle = transition.settle;
            transition.settle = null;
            restoreVolume(transition);
            settle?.();
            if (options.advance) await deps.next();
        };

        const startFallback = async (_reason) => {
            if (active) return;
            const transition = {
                token: ++token,
                volume: deps.getVolume(),
                settle: null,
                phase: "fade-out",
            };
            active = transition;
            const totalDuration = Math.max(2, deps.durationMs());
            const startedAt = deps.now();
            const halfDuration = totalDuration / 2;
            try {
                await animate(transition, halfDuration, fadeOutGain);
                if (transition.token !== token) return;
                transition.phase = "awaiting-change";
                const songChanged = deps.waitForSongChange();
                await deps.next();
                if (transition.token !== token) return;
                const confirmed = await songChanged;
                if (transition.token !== token) return;
                if (confirmed === false) return;
                transition.phase = "fade-in";
                const remainingDuration = Math.max(1, totalDuration - (deps.now() - startedAt));
                await animate(transition, remainingDuration, fadeInGain);
            } finally {
                if (transition.token === token) {
                    active = null;
                    restoreVolume(transition);
                }
            }
        };

        const beginFallback = (reason) => {
            if (active) return false;
            startFallback(reason).catch((error) => reportError(error));
            return true;
        };

        return {
            startFallback,
            beginFallback,
            cancel,
            state: () => active ? "fallback" : "idle",
            expectsSongChange: () => active?.phase === "awaiting-change",
        };
    };

    const isPlayableTarget = (item) => {
        if (!item) return false;
        const metadata = item.contextTrack?.metadata || item.metadata || {};
        if (item.isPlayable === false || item.is_playable === false) return false;
        if (String(metadata.is_playable).toLowerCase() === "false") return false;
        if (String(metadata.is_restricted).toLowerCase() === "true") return false;
        return Boolean(item.uri || item.contextTrack?.uri || metadata.uri);
    };

    const isFallbackEligible = (item, durationMs, progressMs, totalMs, nextItem) => {
        if (!item || item.type !== "track") return false;
        if (item.isLocal || String(item.uri || "").startsWith("spotify:local:")) return false;
        if (nextItem !== undefined && !isPlayableTarget(nextItem)) return false;
        if (![durationMs, progressMs, totalMs].every(Number.isFinite)) return false;
        if (durationMs <= 0 || totalMs < durationMs * 2) return false;
        const remaining = totalMs - progressMs;
        return remaining > 0 && remaining <= durationMs;
    };

    const maybeStartAutomatic = (options) => {
        if (!options.enabled || options.nativeAutomatic) return false;
        if (!isFallbackEligible(
            options.item,
            options.durationMs,
            options.progressMs,
            options.totalMs,
            options.nextItem,
        )) {
            return false;
        }
        return options.startFallback("automatic") !== false;
    };

    const requestNext = async (options) => {
        if (options.nativeManual && typeof options.crossfadeToNext === "function") {
            await options.crossfadeToNext();
            return "native";
        }
        await options.startFallback("manual");
        return "fallback";
    };

    const isProgressDiscontinuity = (
        previousProgress,
        currentProgress,
        elapsedMs,
        toleranceMs = 1500,
    ) => {
        if (![previousProgress, currentProgress, elapsedMs].every(Number.isFinite)) return false;
        return Math.abs((currentProgress - previousProgress) - elapsedMs) > toleranceMs;
    };

    const installMethodInterceptor = (target, methodName, replacement) => {
        const original = target[methodName];
        const hadOwnMethod = Object.hasOwn(target, methodName);
        try {
            target[methodName] = replacement;
        } catch (_error) {
            return null;
        }
        if (target[methodName] !== replacement) return null;
        return () => {
            if (target[methodName] !== replacement) return;
            if (hadOwnMethod) target[methodName] = original;
            else delete target[methodName];
        };
    };

    const installNextInterceptor = (player, replacement) =>
        installMethodInterceptor(player, "next", replacement);

    const isExpectedTrackChange = (sourceUri, expectedUri, actualUri) => {
        if (!actualUri || actualUri === sourceUri) return false;
        return expectedUri ? actualUri === expectedUri : true;
    };

    const renderSettingsMarkup = ({ enabled, durationSec, status }) => `
        <div class="g__row">
            <span class="g__label">Glide</span>
            <span class="g__value" id="g-value">${clampDuration(durationSec)}s</span>
        </div>
        <input class="g__range" id="g-range" type="range"
            min="1" max="15" step="0.5" value="${clampDuration(durationSec)}"/>
        <div class="g__ticks"><span>1s</span><span>5s</span><span>10s</span><span>15s</span></div>
        <p class="g__helper">Seamless transition timing</p>
        <p class="g__status" id="g-status">${status}</p>
        <div class="g__divider"></div>
        <div class="g__row">
            <span class="g__label">Enable Glide</span>
            <button class="g__toggle ${enabled ? "on" : ""}" id="g-toggle"
                role="switch" aria-checked="${enabled}"></button>
        </div>
    `;

    return {
        clampDuration,
        fadeOutGain,
        fadeInGain,
        loadSettings,
        probeNativeCapability,
        createLatestProbe,
        createTransitionController,
        isFallbackEligible,
        maybeStartAutomatic,
        requestNext,
        isProgressDiscontinuity,
        installMethodInterceptor,
        installNextInterceptor,
        isExpectedTrackChange,
        renderSettingsMarkup,
    };
})();

if (typeof module !== "undefined" && module.exports) {
    module.exports = { GlideCore };
}

if (typeof Spicetify !== "undefined") {
(async function Glide() {
    if (
        !Spicetify?.Player?.addEventListener ||
        !Spicetify?.Player?.getProgress ||
        !Spicetify?.Player?.getDuration ||
        !Spicetify?.Player?.getVolume ||
        !Spicetify?.Player?.setVolume ||
        !Spicetify?.Player?.next ||
        !Spicetify?.Player?.isPlaying ||
        !Spicetify?.Platform?.PlayerAPI?.skipToNext ||
        !Spicetify?.Playbar ||
        !Spicetify?.PopupModal ||
        !Spicetify?.LocalStorage ||
        !Spicetify?.Platform
    ) {
        setTimeout(Glide, 300);
        return;
    }

    const LOG = "[Glide]";
    const log = (...args) => console.log(LOG, ...args);
    const warn = (...args) => console.warn(LOG, ...args);
    const error = (...args) => console.error(LOG, ...args);
    const ICON = `<svg viewBox="0 0 16 16" height="16" width="16" fill="currentColor">
        <path d="M9.3 1 3 9h4l-.7 6L13 6H9.2z"/>
    </svg>`;

    const settings = GlideCore.loadSettings(Spicetify.LocalStorage);
    let enabled = settings.enabled;
    let durationSec = settings.durationSec;
    let capabilities = { automatic: false, manual: false };
    let capabilityStatus = "checking";
    let automaticTrackUri = null;
    let lastProgress = 0;
    let lastProgressAt = 0;
    let songChangeWaiters = [];
    let playbarButton = null;
    let menuItem = null;
    const rawNext = Spicetify.Platform.PlayerAPI.skipToNext.bind(
        Spicetify.Platform.PlayerAPI,
    );

    const saveSettings = () => {
        Spicetify.LocalStorage.set("glide:enabled", String(enabled));
        Spicetify.LocalStorage.set("glide:duration", String(durationSec));
    };

    const waitForSongChange = () => new Promise((resolve) => {
        const entry = {
            sourceUri: Spicetify.Player.data?.item?.uri || null,
            expectedUri: Spicetify.Queue?.nextTracks?.[0]?.uri ||
                Spicetify.Queue?.nextTracks?.[0]?.contextTrack?.uri ||
                null,
            resolve: (confirmed) => {
                clearTimeout(timeout);
                resolve(confirmed);
            },
        };
        const timeout = setTimeout(() => {
            songChangeWaiters = songChangeWaiters.filter((waiter) => waiter !== entry);
            resolve(false);
        }, 3000);
        songChangeWaiters.push(entry);
    });

    const controller = GlideCore.createTransitionController({
        durationMs: () => durationSec * 1000,
        now: () => performance.now(),
        requestFrame: (callback) => requestAnimationFrame(callback),
        getVolume: () => Spicetify.Player.getVolume(),
        setVolume: (volume) => Spicetify.Player.setVolume(volume),
        next: () => rawNext(),
        waitForSongChange,
    });

    const statusCopy = () => capabilityStatus === "checking"
        ? "Checking Spotify…"
        : capabilityStatus === "native"
            ? "Native crossfade"
            : "Fallback fade";

    const runCapabilityProbe = GlideCore.createLatestProbe(
        (seconds) => GlideCore.probeNativeCapability(
            Spicetify.Platform,
            seconds,
            { warn },
        ),
        (result) => {
            capabilities = result;
            capabilityStatus = result.automatic ? "native" : "fallback";
            log("Transition capability:", result);
        },
    );

    const probeCapability = async () => {
        capabilityStatus = "checking";
        await runCapabilityProbe(durationSec);
    };

    const normalizedItem = () => {
        const item = Spicetify.Player.data?.item;
        const uri = item?.uri || "";
        const inferredType = uri.startsWith("spotify:track:") ? "track"
            : uri.startsWith("spotify:episode:") ? "episode"
                : item?.type;
        return item ? { ...item, type: inferredType } : null;
    };

    const checkProgress = async () => {
        if (!enabled || !Spicetify.Player.isPlaying()) return;
        const item = normalizedItem();
        if (!item?.uri) return;
        const progressMs = Spicetify.Player.getProgress();
        const progressAt = performance.now();
        if (
            controller.state() === "fallback" &&
            lastProgressAt > 0 &&
            GlideCore.isProgressDiscontinuity(
                lastProgress,
                progressMs,
                progressAt - lastProgressAt,
            )
        ) {
            automaticTrackUri = null;
            await controller.cancel("seek");
            lastProgress = progressMs;
            lastProgressAt = progressAt;
            return;
        }
        lastProgress = progressMs;
        lastProgressAt = progressAt;
        if (automaticTrackUri === item.uri) return;
        const started = GlideCore.maybeStartAutomatic({
            enabled,
            nativeAutomatic: capabilities.automatic,
            item,
            nextItem: Spicetify.Queue?.nextTracks?.[0] ?? null,
            durationMs: durationSec * 1000,
            progressMs,
            totalMs: Spicetify.Player.getDuration(),
            startFallback: (reason) => controller.beginFallback(reason),
        });
        if (started) automaticTrackUri = item.uri;
    };

    const requestManualNext = async () => {
        if (!enabled) return rawNext();
        if (controller.state() === "fallback") {
            return controller.cancel("repeated-next", { advance: true });
        }
        return GlideCore.requestNext({
            nativeManual: capabilities.manual,
            crossfadeToNext: () => Spicetify.Platform.PlayerAPI.crossfadeToNext(durationSec),
            startFallback: (reason) => controller.startFallback(reason),
        });
    };

    const updateControls = () => {
        if (playbarButton) {
            playbarButton.active = enabled;
            playbarButton.label = enabled ? "Glide: ON" : "Glide: OFF";
        }
        if (menuItem) menuItem.isEnabled = enabled;
    };

    const openSettingsModal = () => {
        const container = document.createElement("div");
        container.innerHTML = `
            <style>
                .g{width:390px;max-width:calc(100vw - 48px);padding:12px 4px 4px;color:var(--spice-text,#fff)}
                .g__row{display:flex;align-items:center;justify-content:space-between;margin:8px 0}
                .g__label{font-size:22px;font-weight:700}
                .g__value{font-size:22px;font-weight:700;color:#1ed760}
                .g__range{appearance:none;width:100%;height:6px;border-radius:6px;background:#3e3e3e;margin:20px 0 8px}
                .g__range::-webkit-slider-thumb{appearance:none;width:24px;height:24px;border-radius:50%;background:#1ed760;cursor:pointer}
                .g__ticks{display:flex;justify-content:space-between;color:var(--spice-subtext,#b3b3b3);font-size:13px}
                .g__helper{text-align:center;color:var(--spice-subtext,#b3b3b3);font-size:15px;margin:18px 0 8px}
                .g__status{text-align:center;color:#1ed760;font-size:12px;margin:0 0 18px}
                .g__divider{height:1px;background:rgba(255,255,255,.12);margin:0 0 18px}
                .g__toggle{position:relative;width:52px;height:28px;border:0;border-radius:20px;background:#535353;cursor:pointer}
                .g__toggle.on{background:#1ed760}
                .g__toggle::after{content:'';position:absolute;top:3px;left:3px;width:22px;height:22px;border-radius:50%;background:#fff;transition:transform .2s}
                .g__toggle.on::after{transform:translateX(24px)}
                .g__footer{text-align:center;color:var(--spice-subtext,#b3b3b3);opacity:.45;font-size:11px;margin-top:22px}
            </style>
            <div class="g">
                ${GlideCore.renderSettingsMarkup({
                    enabled,
                    durationSec,
                    status: statusCopy(),
                })}
                <div class="g__footer">Glide v4.0.0</div>
            </div>`;

        const range = container.querySelector("#g-range");
        const value = container.querySelector("#g-value");
        const status = container.querySelector("#g-status");
        range.addEventListener("input", async () => {
            durationSec = GlideCore.clampDuration(range.value);
            value.textContent = `${durationSec}s`;
            saveSettings();
            status.textContent = "Checking Spotify…";
            await probeCapability();
            status.textContent = statusCopy();
        });

        const toggle = container.querySelector("#g-toggle");
        toggle.addEventListener("click", async () => {
            enabled = !enabled;
            toggle.classList.toggle("on", enabled);
            toggle.setAttribute("aria-checked", String(enabled));
            if (!enabled) await controller.cancel("disabled");
            saveSettings();
            updateControls();
            Spicetify.showNotification(enabled ? "Glide enabled" : "Glide disabled");
        });

        Spicetify.PopupModal.display({ title: "⚡ Glide", content: container });
    };

    playbarButton = new Spicetify.Playbar.Button(
        enabled ? "Glide: ON" : "Glide: OFF",
        ICON,
        openSettingsModal,
        false,
        enabled,
    );

    if (Spicetify.Menu?.Item) {
        menuItem = new Spicetify.Menu.Item(
            "Enable Glide",
            enabled,
            async () => {
                enabled = !enabled;
                if (!enabled) await controller.cancel("disabled");
                saveSettings();
                updateControls();
            },
            ICON,
        );
        menuItem.register();
    }

    const restoreNext = GlideCore.installMethodInterceptor(
        Spicetify.Platform.PlayerAPI,
        "skipToNext",
        requestManualNext,
    );
    if (!restoreNext) warn("PlayerAPI.skipToNext interception is unavailable");

    Spicetify.Player.addEventListener("onprogress", () => {
        checkProgress().catch((progressError) => error("Progress check failed:", progressError));
    });
    Spicetify.Player.addEventListener("songchange", () => {
        automaticTrackUri = null;
        lastProgress = 0;
        lastProgressAt = 0;
        if (controller.expectsSongChange()) {
            const waiters = songChangeWaiters;
            songChangeWaiters = [];
            const actualUri = Spicetify.Player.data?.item?.uri || null;
            waiters.forEach((waiter) => waiter.resolve(
                GlideCore.isExpectedTrackChange(
                    waiter.sourceUri,
                    waiter.expectedUri,
                    actualUri,
                ),
            ));
        } else if (controller.state() === "fallback") {
            controller.cancel("unrelated-songchange")
                .catch((cancelError) => error("Song-change cancel failed:", cancelError));
        }
    });
    Spicetify.Player.addEventListener("onplaypause", () => {
        if (!Spicetify.Player.isPlaying()) {
            controller.cancel("pause").catch((cancelError) => error("Cancel failed:", cancelError));
        }
    });

    const handleDeviceChange = async () => {
        await controller.cancel("device-change");
        automaticTrackUri = null;
        lastProgress = 0;
        lastProgressAt = 0;
        await probeCapability();
    };
    try {
        Spicetify.Player.addEventListener("devicechange", () => {
            handleDeviceChange().catch((deviceError) => error("Device change failed:", deviceError));
        });
        Spicetify.Platform.PlayerAPI?.addEventListener?.("devicechange", () => {
            handleDeviceChange().catch((deviceError) => error("Device change failed:", deviceError));
        });
    } catch (deviceListenerError) {
        warn("Device-change events are unavailable:", deviceListenerError);
    }

    setInterval(() => {
        checkProgress().catch((progressError) => error("Heartbeat failed:", progressError));
    }, 400);

    await probeCapability();
    updateControls();
    if (enabled) Spicetify.showNotification(`Glide 4.0 · ${statusCopy()}`);
    log("v4.0.0 loaded", { enabled, durationSec, capabilities });
})();
}
