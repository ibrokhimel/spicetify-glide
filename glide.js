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
        const config = platform?.ConfigAPI;
        if (
            typeof config?.setAccountSetting !== "function" ||
            typeof config?.getAccountSetting !== "function"
        ) {
            return result;
        }

        const durationMs = clampDuration(durationSec) * 1000;
        try {
            await config.setAccountSetting("audio.crossfade_v2", true);
            await config.setAccountSetting("audio.crossfade.time_v2", durationMs);
            const enabled = await config.getAccountSetting("audio.crossfade_v2");
            const configuredDuration = await config.getAccountSetting("audio.crossfade.time_v2");
            result.automatic = enabled === true && Number(configuredDuration) === durationMs;
        } catch (error) {
            logger?.warn?.("[Glide] Native crossfade probe failed", error);
        }
        return result;
    };

    const createTransitionController = (deps) => {
        let token = 0;
        let active = null;

        const animate = (transition, durationMs, gain) => new Promise((resolve) => {
            const startedAt = deps.now();
            transition.settle = resolve;
            const step = () => {
                if (transition.token !== token) {
                    resolve();
                    return;
                }
                const progress = Math.min(1, Math.max(0, (deps.now() - startedAt) / durationMs));
                deps.setVolume(transition.volume * gain(progress));
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
            deps.setVolume(transition.volume);
            transition.settle?.();
            if (options.advance) await deps.next();
        };

        const startFallback = async (_reason) => {
            if (active) return;
            const transition = {
                token: ++token,
                volume: deps.getVolume(),
                settle: null,
            };
            active = transition;
            const halfDuration = Math.max(1, deps.durationMs() / 2);
            try {
                await animate(transition, halfDuration, fadeOutGain);
                if (transition.token !== token) return;
                const songChanged = deps.waitForSongChange();
                await deps.next();
                if (transition.token !== token) return;
                await songChanged;
                if (transition.token !== token) return;
                await animate(transition, halfDuration, fadeInGain);
            } finally {
                if (transition.token === token) {
                    deps.setVolume(transition.volume);
                    active = null;
                }
            }
        };

        return {
            startFallback,
            cancel,
            state: () => active ? "fallback" : "idle",
        };
    };

    const isFallbackEligible = (item, durationMs, progressMs, totalMs) => {
        if (!item || item.type !== "track") return false;
        if (item.isLocal || String(item.uri || "").startsWith("spotify:local:")) return false;
        if (![durationMs, progressMs, totalMs].every(Number.isFinite)) return false;
        if (durationMs <= 0 || totalMs < durationMs * 2) return false;
        const remaining = totalMs - progressMs;
        return remaining > 0 && remaining <= durationMs;
    };

    const maybeStartAutomatic = async (options) => {
        if (!options.enabled || options.nativeAutomatic) return false;
        if (!isFallbackEligible(
            options.item,
            options.durationMs,
            options.progressMs,
            options.totalMs,
        )) {
            return false;
        }
        await options.startFallback("automatic");
        return true;
    };

    const requestNext = async (options) => {
        if (options.nativeManual && typeof options.crossfadeToNext === "function") {
            await options.crossfadeToNext();
            return "native";
        }
        await options.startFallback("manual");
        return "fallback";
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
        createTransitionController,
        isFallbackEligible,
        maybeStartAutomatic,
        requestNext,
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
    let songChangeWaiters = [];
    let playbarButton = null;
    let menuItem = null;
    const rawNext = Spicetify.Player.next.bind(Spicetify.Player);

    const saveSettings = () => {
        Spicetify.LocalStorage.set("glide:enabled", String(enabled));
        Spicetify.LocalStorage.set("glide:duration", String(durationSec));
    };

    const waitForSongChange = () => new Promise((resolve) => {
        const waiter = () => {
            clearTimeout(timeout);
            resolve();
        };
        const timeout = setTimeout(() => {
            songChangeWaiters = songChangeWaiters.filter((entry) => entry !== waiter);
            resolve();
        }, 3000);
        songChangeWaiters.push(waiter);
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

    const probeCapability = async () => {
        capabilityStatus = "checking";
        capabilities = await GlideCore.probeNativeCapability(
            Spicetify.Platform,
            durationSec,
            { warn },
        );
        capabilityStatus = capabilities.automatic ? "native" : "fallback";
        log("Transition capability:", capabilities);
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
        if (!item?.uri || automaticTrackUri === item.uri) return;
        const progressMs = Spicetify.Player.getProgress();
        if (progressMs + 1500 < lastProgress) {
            automaticTrackUri = null;
            await controller.cancel("seek");
        }
        lastProgress = progressMs;
        const started = await GlideCore.maybeStartAutomatic({
            enabled,
            nativeAutomatic: capabilities.automatic,
            item,
            durationMs: durationSec * 1000,
            progressMs,
            totalMs: Spicetify.Player.getDuration(),
            startFallback: (reason) => controller.startFallback(reason),
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

    try {
        Spicetify.Player.next = requestManualNext;
    } catch (interceptionError) {
        warn("Manual Next interception is unavailable:", interceptionError);
    }

    Spicetify.Player.addEventListener("onprogress", () => {
        checkProgress().catch((progressError) => error("Progress check failed:", progressError));
    });
    Spicetify.Player.addEventListener("songchange", () => {
        automaticTrackUri = null;
        lastProgress = 0;
        const waiters = songChangeWaiters;
        songChangeWaiters = [];
        waiters.forEach((resolve) => resolve());
    });
    Spicetify.Player.addEventListener("onplaypause", () => {
        if (!Spicetify.Player.isPlaying()) {
            controller.cancel("pause").catch((cancelError) => error("Cancel failed:", cancelError));
        }
    });

    setInterval(() => {
        checkProgress().catch((progressError) => error("Heartbeat failed:", progressError));
    }, 400);

    await probeCapability();
    updateControls();
    if (enabled) Spicetify.showNotification(`Glide 4.0 · ${statusCopy()}`);
    log("v4.0.0 loaded", { enabled, durationSec, capabilities });
})();
}
