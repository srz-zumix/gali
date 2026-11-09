import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

function deferred() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
}

async function waitFor(predicate) {
    const deadline = Date.now() + 3000;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error("timed out waiting for the test state");
        await delay(5);
    }
}

function result(summary, { cached = false, fetchedAt = "2026-03-01T10:00:00.000Z" } = {}) {
    return { summary, timeZone: "", accessRole: "", events: [], cached, fetchedAt };
}

test("viewport fetch ownership and cached navigation", { timeout: 10000 }, async (t) => {
    const directory = await mkdtemp(path.join(tmpdir(), "gali-state-cache-"));
    const originalHome = process.env.COPILOT_HOME;
    process.env.COPILOT_HOME = directory;
    const [{ ProfileState, resolveRange, shiftAnchor, todayISO }, { loadSettings, sanitizeSettings }, { presetStore }] = await Promise.all([
        import("./state.mjs"),
        import("./store.mjs"),
        import("./presets.mjs"),
    ]);
    t.after(async () => {
        presetStore.close();
        if (originalHome === undefined) delete process.env.COPILOT_HOME;
        else process.env.COPILOT_HOME = originalHome;
        await rm(directory, { recursive: true, force: true });
    });

    function profile(name, fetchCalendarWeek, anchor = "2026-03-03") {
        const state = new ProfileState(name, { fetchCalendarWeek, prune: async () => {} });
        state.settings = sanitizeSettings({ calendars: [{ id: "alice" }], anchor, view: "day" });
        return state;
    }

    await t.test("week ranges begin on the selected day across calendar boundaries", () => {
        const cases = [
            [
                "2026-03-04",
                "2026-03-04 2026-03-05 2026-03-06 2026-03-07 2026-03-08 2026-03-09 2026-03-10",
                "2026-02-25", "2026-03-11",
            ],
            [
                "2026-03-08",
                "2026-03-08 2026-03-09 2026-03-10 2026-03-11 2026-03-12 2026-03-13 2026-03-14",
                "2026-03-01", "2026-03-15",
            ],
            [
                "2024-02-28",
                "2024-02-28 2024-02-29 2024-03-01 2024-03-02 2024-03-03 2024-03-04 2024-03-05",
                "2024-02-21", "2024-03-06",
            ],
            [
                "2026-12-30",
                "2026-12-30 2026-12-31 2027-01-01 2027-01-02 2027-01-03 2027-01-04 2027-01-05",
                "2026-12-23", "2027-01-06",
            ],
            [
                "0101-01-01",
                "0101-01-01 0101-01-02 0101-01-03 0101-01-04 0101-01-05 0101-01-06 0101-01-07",
                "0100-12-25", "0101-01-08",
            ],
            [
                "9998-12-31",
                "9998-12-31 9999-01-01 9999-01-02 9999-01-03 9999-01-04 9999-01-05 9999-01-06",
                "9998-12-24", "9999-01-07",
            ],
        ];
        for (const [anchor, dayList, previous, next] of cases) {
            const settings = { anchor, view: "week" };
            const days = dayList.split(" ");
            assert.deepEqual(resolveRange(settings), { anchor, since: anchor, until: days[6], days });
            assert.equal(shiftAnchor(settings, -1), previous);
            assert.equal(shiftAnchor(settings, 1), next);
        }
    });

    await t.test("boundary-year rolling weeks keep canonical cache chunk dates", async () => {
        const calls = [];
        const state = profile("boundary-week", async (_id, since, until, _options, controls) => {
            if (controls.cacheOnly) return null;
            calls.push([since, until]);
            return result(since);
        }, "0101-01-01");
        state.settings = sanitizeSettings({ ...state.settings, view: "week" });
        await state.refresh();
        assert.equal(state.snapshot.range.since, "0101-01-01");
        assert.equal(state.snapshot.range.until, "0101-01-07");
        assert.deepEqual(calls, [["0100-12-27", "0101-01-02"], ["0101-01-03", "0101-01-09"]]);

        calls.length = 0;
        await state.updateSettings({ anchor: "9998-12-31" });
        assert.equal(state.snapshot.range.since, "9998-12-31");
        assert.equal(state.snapshot.range.until, "9999-01-06");
        assert.deepEqual(calls, [["9998-12-28", "9999-01-03"], ["9999-01-04", "9999-01-10"]]);
    });

    await t.test("default and persisted starts survive view changes and reload", async () => {
        const defaults = sanitizeSettings({});
        const before = todayISO();
        const defaultRange = resolveRange(defaults);
        const after = todayISO();
        assert.equal(defaults.anchor, "");
        assert.ok([before, after].includes(defaultRange.anchor));
        assert.equal(defaultRange.since, defaultRange.anchor);
        assert.equal(defaultRange.days.length, 7);

        const state = profile("rolling-persistence", async () => { throw new Error("unexpected fetch"); }, "2026-03-04");
        for (const view of ["3days", "day", "week"]) {
            await state.updateSettings({ view }, { refresh: false });
            assert.equal(state.settings.anchor, "2026-03-04");
            assert.equal(state.toJSON().range.since, "2026-03-04");
        }
        const restored = await loadSettings("rolling-persistence");
        assert.equal(restored.view, "week");
        assert.equal(restored.anchor, "2026-03-04");
        assert.equal(resolveRange(restored).since, "2026-03-04");
    });

    await t.test("overlapping rolling weeks cannot publish an obsolete fetch", async () => {
        const firstStarted = deferred();
        const releaseFirst = deferred();
        const secondStarted = deferred();
        const releaseSecond = deferred();
        let secondChunkCalls = 0;
        const state = profile("overlapping-weeks", async (_id, since, _until, _options, controls) => {
            if (controls.cacheOnly) return since === "2026-03-02" ? result("first", { cached: true }) : null;
            if (since === "2026-03-02") return result("first", { cached: true });
            assert.equal(since, "2026-03-09");
            secondChunkCalls += 1;
            if (secondChunkCalls === 1) {
                firstStarted.resolve();
                await releaseFirst.promise;
                throw new Error("obsolete failure");
            }
            secondStarted.resolve();
            await releaseSecond.promise;
            return result("second");
        }, "2026-03-04");
        state.settings = sanitizeSettings({ ...state.settings, view: "week" });
        const first = state.refresh();
        let second;
        try {
            await firstStarted.promise;
            second = state.updateSettings({ anchor: "2026-03-05" });
            await waitFor(() => state.queuedFetch && state.settings.anchor === "2026-03-05");
            releaseFirst.resolve();
            await secondStarted.promise;
            await first;
            assert.equal(state.snapshot, null);
            assert.equal(state.loading, true);
            assert.equal(state.error, null);
            releaseSecond.resolve();
            await second;
            assert.equal(state.snapshot.range.since, "2026-03-05");
            assert.equal(state.snapshot.range.until, "2026-03-11");
            assert.equal(state.snapshot.calendars[0].error, null);
            assert.equal(state.loading, false);
            assert.equal(state.error, null);
        } finally {
            releaseFirst.resolve();
            releaseSecond.resolve();
            await Promise.allSettled([first, second].filter(Boolean));
        }
    });

    await t.test("a delayed cache probe cannot overwrite a forced refresh", async () => {
        const probeStarted = deferred();
        const releaseProbe = deferred();
        const state = profile("delayed-probe", async (_id, _since, _until, _options, controls) => {
            if (controls.cacheOnly) {
                probeStarted.resolve();
                await releaseProbe.promise;
                return result("old", { cached: true });
            }
            assert.equal(controls.force, true);
            return result("new", { fetchedAt: "2026-03-01T10:01:00.000Z" });
        });
        const probe = state.refresh();
        await probeStarted.promise;
        await state.refresh({ force: true });
        assert.equal(state.snapshot.calendars[0].summary, "new");
        releaseProbe.resolve();
        await probe;
        assert.equal(state.snapshot.calendars[0].summary, "new");
        assert.equal(state.snapshot.fetchedAt, "2026-03-01T10:01:00.000Z");
        assert.equal(state.loading, false);
    });

    await t.test("ordinary refresh joins an active forced refresh", async () => {
        const forceStarted = deferred();
        const releaseForce = deferred();
        let probes = 0;
        const state = profile("force-join", async (_id, _since, _until, _options, controls) => {
            if (controls.cacheOnly) {
                probes += 1;
                return result("old", { cached: true });
            }
            assert.equal(controls.force, true);
            forceStarted.resolve();
            await releaseForce.promise;
            return result("new");
        });
        await state.refresh();
        const forced = state.refresh({ force: true });
        await forceStarted.promise;
        const ordinary = state.refresh();
        assert.equal(ordinary, forced);
        assert.equal(probes, 1);
        assert.equal(state.loading, true);
        releaseForce.resolve();
        await Promise.all([forced, ordinary]);
        assert.equal(state.snapshot.calendars[0].summary, "new");
        assert.equal(state.loading, false);
    });

    await t.test("returning to a cached week bypasses an unrelated slow fetch", async () => {
        const slowStarted = deferred();
        const releaseSlow = deferred();
        const state = profile("cached-return", async (_id, since, _until, _options, controls) => {
            if (controls.cacheOnly) return since === "2026-03-02" ? result("cached", { cached: true }) : null;
            slowStarted.resolve();
            await releaseSlow.promise;
            throw new Error("obsolete failure");
        }, "2026-03-10");
        const slow = state.refresh();
        await slowStarted.promise;
        await state.updateSettings({ anchor: "2026-03-03" });
        assert.equal(state.snapshot.calendars[0].summary, "cached");
        assert.equal(state.loading, false);
        releaseSlow.resolve();
        await slow;
        assert.equal(state.snapshot.calendars[0].summary, "cached");
        assert.equal(state.error, null);
        assert.equal(state.loading, false);
    });

    await t.test("queued requests keep their own range and skip superseded work", async () => {
        const firstStarted = deferred();
        const releaseFirst = deferred();
        const calls = [];
        const state = profile("queued-range", async (_id, since, _until, _options, controls) => {
            if (controls.cacheOnly) return null;
            calls.push(since);
            if (since === "2026-03-02") {
                firstStarted.resolve();
                await releaseFirst.promise;
            }
            return result(since);
        });
        const first = state.refresh();
        await firstStarted.promise;
        const second = state.updateSettings({ anchor: "2026-03-10" });
        await waitFor(() => state.queuedFetch && state.settings.anchor === "2026-03-10");
        const oldTail = state.queuedFetch;
        const third = state.updateSettings({ anchor: "2026-03-17" });
        await waitFor(() => state.queuedFetch && state.queuedFetch !== oldTail && state.settings.anchor === "2026-03-17");
        assert.deepEqual(calls, ["2026-03-02"]);
        releaseFirst.resolve();
        await Promise.all([first, second, third]);
        assert.deepEqual(calls, ["2026-03-02", "2026-03-16"]);
        assert.equal(state.snapshot.range.anchor, "2026-03-17");
        assert.equal(state.snapshot.calendars[0].summary, "2026-03-16");
        assert.equal(state.loading, false);
    });

    await t.test("an earlier fetch cannot publish or stop a queued force", async () => {
        const firstStarted = deferred();
        const releaseFirst = deferred();
        const forceStarted = deferred();
        const releaseForce = deferred();
        const state = profile("queued-force", async (_id, _since, _until, _options, controls) => {
            if (controls.cacheOnly) return null;
            if (controls.force) {
                forceStarted.resolve();
                await releaseForce.promise;
                return result("new");
            }
            firstStarted.resolve();
            await releaseFirst.promise;
            return result("old");
        });
        const first = state.refresh();
        await firstStarted.promise;
        const forced = state.refresh({ force: true });
        const ordinary = state.refresh();
        assert.equal(ordinary, forced);
        releaseFirst.resolve();
        await first;
        await forceStarted.promise;
        assert.equal(state.snapshot, null);
        assert.equal(state.loading, true);
        releaseForce.resolve();
        await Promise.all([forced, ordinary]);
        assert.equal(state.snapshot.calendars[0].summary, "new");
        assert.equal(state.loading, false);
    });

    await t.test("invalidating without an immediate fetch clears obsolete loading", async () => {
        const started = deferred();
        const release = deferred();
        const state = profile("invalidate", async (_id, _since, _until, _options, controls) => {
            if (controls.cacheOnly) return null;
            started.resolve();
            await release.promise;
            return result("obsolete");
        });
        const fetching = state.refresh();
        await started.promise;
        assert.equal(state.loading, true);
        await state.updateSettings({ anchor: "2026-03-10" }, { refresh: false });
        assert.equal(state.loading, false);
        assert.equal(state.snapshot, null);
        release.resolve();
        await fetching;
        assert.equal(state.snapshot, null);
        assert.equal(state.loading, false);
    });
});
