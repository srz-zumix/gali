import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { test } from "node:test";

import { createCalendarCache, mergeEventChunks } from "./cache.mjs";
import { GaliError } from "./gali.mjs";

const SINCE = "2026-03-02";
const UNTIL = "2026-03-08";
const value = (summary, events = []) => ({ summary, timeZone: "", accessRole: "", events });

function deferred() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
}

function memoryDisk() {
    const records = new Map();
    return {
        records,
        read: async (key) => records.get(key) || null,
        write: async (key, record) => { records.set(key, record); },
    };
}

test("cache-only, TTL, disk promotion and cache identities", async () => {
    const disk = memoryDisk();
    let clock = Date.parse("2026-03-01T10:00:00Z");
    let binary = "first";
    let calls = 0;
    const cache = createCalendarCache({
        ...disk,
        now: () => clock,
        resolveBinary: async () => binary,
        collect: async () => value(`fetch-${++calls}`),
    });
    const fetch = (options = {}, controls = {}) => cache.fetchWeek("alice", SINCE, UNTIL, options, controls);

    assert.equal(await fetch({}, { cacheOnly: true }), null);
    assert.equal(calls, 0);
    await assert.rejects(fetch({}, { cacheOnly: true, force: true }), TypeError);
    const first = await fetch();
    assert.equal(first.cached, false);
    assert.equal(first.fetchedAt, "2026-03-01T10:00:00.000Z");
    clock += 14 * 60_000;
    cache.clearMemoryCache();
    const fromDisk = await fetch({}, { cacheOnly: true });
    assert.equal(fromDisk.cached, true);
    assert.equal(fromDisk.fetchedAt, first.fetchedAt);
    assert.equal(calls, 1);
    clock += 60_000;
    assert.equal(await fetch({}, { cacheOnly: true }), null);
    const expired = await fetch();
    assert.equal(expired.summary, "fetch-2");
    assert.equal(expired.fetchedAt, "2026-03-01T10:15:00.000Z");

    await fetch({ refs: ["a,b"] });
    await fetch({ refs: ["a", "b"] });
    assert.equal(calls, 4);
    binary = "second";
    await fetch();
    assert.equal(calls, 5);
    binary = "first";
    assert.equal((await fetch()).summary, "fetch-2");
    assert.equal(calls, 5);
});

test("simultaneous misses coalesce and a forced fetch waits for the active fetch", { timeout: 5000 }, async () => {
    const firstStarted = deferred();
    const firstRelease = deferred();
    const forcedStarted = deferred();
    const forcedRelease = deferred();
    let calls = 0;
    const cache = createCalendarCache({
        ...memoryDisk(),
        resolveBinary: async () => "fake",
        collect: async () => {
            calls += 1;
            if (calls === 1) {
                firstStarted.resolve();
                await firstRelease.promise;
                return value("first");
            }
            forcedStarted.resolve();
            await forcedRelease.promise;
            return value("forced");
        },
    });
    const fetch = (controls = {}) => cache.fetchWeek("alice", SINCE, UNTIL, {}, controls);
    const first = fetch();
    await firstStarted.promise;
    const shared = fetch();
    await nextTurn();
    assert.equal(calls, 1);
    const forced = fetch({ force: true });
    await nextTurn();
    assert.equal(calls, 1);
    firstRelease.resolve();
    assert.equal((await first).summary, "first");
    assert.equal((await shared).summary, "first");
    await forcedStarted.promise;
    assert.equal(calls, 2);
    forcedRelease.resolve();
    assert.equal((await forced).summary, "forced");
    assert.equal((await fetch()).summary, "forced");
});

test("an active forced refresh takes precedence over an older cache hit", { timeout: 5000 }, async () => {
    const started = deferred();
    const release = deferred();
    let calls = 0;
    const cache = createCalendarCache({
        ...memoryDisk(),
        resolveBinary: async () => "fake",
        collect: async () => {
            calls += 1;
            if (calls === 1) return value("old");
            started.resolve();
            await release.promise;
            return value("new");
        },
    });
    const fetch = (controls = {}) => cache.fetchWeek("alice", SINCE, UNTIL, {}, controls);
    await fetch();
    const forced = fetch({ force: true });
    await started.promise;
    assert.equal(await fetch({ cacheOnly: true }), null);
    let finished = false;
    const joining = fetch().then((result) => { finished = true; return result; });
    await nextTurn();
    assert.equal(finished, false);
    release.resolve();
    assert.equal((await forced).summary, "new");
    assert.equal((await joining).summary, "new");
    assert.equal(calls, 2);
});

test("a delayed disk read cannot replace a newer forced result", { timeout: 5000 }, async () => {
    const started = deferred();
    const release = deferred();
    const clock = Date.parse("2026-03-01T10:00:00Z");
    const cache = createCalendarCache({
        now: () => clock,
        resolveBinary: async () => "fake",
        read: async () => {
            started.resolve();
            await release.promise;
            return { at: clock - 60_000, value: value("old") };
        },
        write: async () => {},
        collect: async () => value("new"),
    });
    const fetch = (controls = {}) => cache.fetchWeek("alice", SINCE, UNTIL, {}, controls);
    const oldRead = fetch({ cacheOnly: true });
    await started.promise;
    assert.equal((await fetch({ force: true })).summary, "new");
    release.resolve();
    assert.equal((await oldRead).summary, "new");
    assert.equal((await fetch()).summary, "new");
});

test("truncated ranges split recursively and merge overlapping occurrences", async () => {
    const calls = [];
    let clock = Date.parse("2026-03-01T10:00:00Z");
    const cache = createCalendarCache({
        ...memoryDisk(),
        now: () => clock,
        resolveBinary: async () => "fake",
        collect: async (_id, options) => {
            calls.push([options.since, options.until, options.refs]);
            const days = (Date.parse(options.until) - Date.parse(options.since)) / 86_400_000 + 1;
            if (days > 2) throw new GaliError("truncated", { code: "calendar_truncated" });
            clock += 1000;
            return value(options.since, [
                { id: "shared", start: "2026-03-02T00:00:00Z", summary: options.since },
                { id: options.since, start: `${options.since}T09:00:00Z` },
            ]);
        },
    });
    const result = await cache.fetchWeek("alice", SINCE, UNTIL, { refs: ["ref"] });
    assert.deepEqual(calls, [
        ["2026-03-02", "2026-03-08", ["ref"]],
        ["2026-03-02", "2026-03-05", ["ref"]],
        ["2026-03-02", "2026-03-03", ["ref"]],
        ["2026-03-04", "2026-03-05", ["ref"]],
        ["2026-03-06", "2026-03-08", ["ref"]],
        ["2026-03-06", "2026-03-07", ["ref"]],
        ["2026-03-08", "2026-03-08", ["ref"]],
    ]);
    assert.equal(result.fetchedAt, "2026-03-01T10:00:01.000Z");
    assert.equal(result.events.length, 5);
    assert.equal(result.events.find((event) => event.id === "shared").summary, "2026-03-08");
    assert.equal((await cache.fetchWeek("alice", SINCE, UNTIL, { refs: ["ref"] })).cached, true);
    assert.equal(calls.length, 7);
});

test("failed splits and unrelated errors never cache partial results", async () => {
    const disk = memoryDisk();
    const calls = [];
    const cache = createCalendarCache({
        ...disk,
        resolveBinary: async () => "fake",
        collect: async (_id, options) => {
            calls.push([options.since, options.until]);
            if (options.since === SINCE && options.until === UNTIL) {
                throw new GaliError("truncated", { code: "calendar_truncated" });
            }
            if (options.since === "2026-03-06") throw new Error("backend failed");
            return value("partial");
        },
    });
    const fetch = (controls = {}) => cache.fetchWeek("alice", SINCE, UNTIL, {}, controls);
    await assert.rejects(fetch(), /backend failed/);
    assert.equal(disk.records.size, 0);
    assert.equal(await fetch({ cacheOnly: true }), null);
    await assert.rejects(fetch(), /backend failed/);
    assert.deepEqual(calls, [
        ["2026-03-02", "2026-03-08"], ["2026-03-02", "2026-03-05"], ["2026-03-06", "2026-03-08"],
        ["2026-03-02", "2026-03-08"], ["2026-03-02", "2026-03-05"], ["2026-03-06", "2026-03-08"],
    ]);

    let singleCalls = 0;
    const single = createCalendarCache({
        ...memoryDisk(),
        resolveBinary: async () => "fake",
        collect: async () => {
            singleCalls += 1;
            throw new GaliError("one day is too large", { code: "calendar_truncated" });
        },
    });
    await assert.rejects(single.fetchWeek("alice", SINCE, SINCE), /one day is too large/);
    assert.equal(singleCalls, 1);
});

test("merge uses occurrence identity, keeps distinct events, and prefers the newest chunk", () => {
    const old = { id: "one", start: "2026-03-02T09:00:00Z", summary: "old" };
    const newer = { ...old, start: "2026-03-03T09:00:00Z", summary: "new" };
    const nextOccurrence = { ...old, id: "two", start: "2026-03-04T09:00:00Z" };
    const uidOnly = { uid: "series", start: "2026-03-05T09:00:00Z" };
    const uidNext = { ...uidOnly, start: "2026-03-06T09:00:00Z" };
    assert.deepEqual(mergeEventChunks([
        { events: [newer, nextOccurrence, uidOnly, uidNext], at: 2 },
        { events: [old, uidOnly], at: 1 },
    ]), [newer, nextOccurrence, uidOnly, uidNext]);
});
