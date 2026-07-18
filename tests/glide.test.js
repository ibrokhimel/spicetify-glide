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
