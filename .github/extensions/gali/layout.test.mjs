import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { HOUR_HEIGHT, MIN_GRID_HEIGHT, computeGeometry, clampGridHeight } from "./ui/layout.mjs";

test("the time axis always covers all 24 hours", () => {
    for (const settings of [
        {},
        { workStart: "09:00", workEnd: "18:00" },
        { workStart: "00:00", workEnd: "23:59" },
        { workStart: "13:30", workEnd: "16:15" },
    ]) {
        const geometry = computeGeometry(settings);
        assert.equal(geometry.startHour, 0);
        assert.equal(geometry.endHour, 24);
        assert.equal(geometry.startMinute, 0);
        assert.equal(geometry.height, 24 * HOUR_HEIGHT);
    }
    const geometry = computeGeometry({ workStart: "13:30", workEnd: "16:15" });
    assert.equal(geometry.workStart, 810);
    assert.equal(geometry.workEnd, 975);
});

test("resizing is bounded by the minimum and available viewport height", () => {
    assert.equal(clampGridHeight(360, 640), 360);
    assert.equal(clampGridHeight(120, 640), MIN_GRID_HEIGHT);
    assert.equal(clampGridHeight(900, 640), 640);
    assert.equal(clampGridHeight(360.6, 640.9), 361);
    assert.equal(clampGridHeight(900, 120), MIN_GRID_HEIGHT);
});

test("viewport height persists per profile without changing working hours", async (t) => {
    const directory = await mkdtemp(path.join(tmpdir(), "gali-layout-test-"));
    const originalHome = process.env.COPILOT_HOME;
    t.after(async () => {
        if (originalHome === undefined) delete process.env.COPILOT_HOME;
        else process.env.COPILOT_HOME = originalHome;
        await rm(directory, { recursive: true, force: true });
    });
    process.env.COPILOT_HOME = directory;
    const { loadSettings, saveSettings, sanitizeSettings } = await import("./store.mjs?layout-test");

    assert.equal(sanitizeSettings({}).gridHeight, 0);
    assert.equal(sanitizeSettings({ gridHeight: 50 }).gridHeight, MIN_GRID_HEIGHT);
    assert.equal(sanitizeSettings({ gridHeight: -10 }).gridHeight, 0);
    assert.equal(sanitizeSettings({ gridHeight: "invalid" }).gridHeight, 0);

    await saveSettings("team-a", { gridHeight: 360, workStart: "10:00", workEnd: "19:00" });
    const saved = await loadSettings("team-a");
    assert.equal(saved.gridHeight, 360);
    assert.equal(saved.workStart, "10:00");
    assert.equal(saved.workEnd, "19:00");
    assert.equal((await loadSettings("team-b")).gridHeight, 0);
    await saveSettings("team-a", { ...saved, gridHeight: 0 });
    assert.equal((await loadSettings("team-a")).gridHeight, 0);
});
