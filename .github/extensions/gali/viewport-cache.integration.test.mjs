import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { busyIntervals } from "./freebusy.mjs";

async function waitFor(predicate) {
    const deadline = Date.now() + 5000;
    while (!(await predicate())) {
        if (Date.now() > deadline) throw new Error("timed out waiting for the test state");
        await delay(10);
    }
}

function timed(id, start, end, summary = id) {
    return { id, summary, start: { dateTime: start }, end: { dateTime: end } };
}

function allDay(id, start, end) {
    return { id, summary: id, start: { date: start }, end: { date: end } };
}

test("calendar viewport reuses weeks through state and HTTP", {
    skip: process.platform === "win32",
    timeout: 30000,
}, async (t) => {
    const directory = await mkdtemp(path.join(tmpdir(), "gali-viewport-cache-"));
    const original = {
        home: process.env.COPILOT_HOME,
        binary: process.env.GALI_BIN,
        timeZone: process.env.TZ,
    };
    const binary = path.join(directory, "gali");
    const controlFile = path.join(directory, "control.json");
    const logFile = path.join(directory, "calls.jsonl");
    process.env.COPILOT_HOME = directory;
    process.env.GALI_BIN = binary;
    process.env.TZ = "America/New_York";

    await writeFile(binary, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const id = args[1];
const since = args[args.indexOf("--since") + 1];
const until = args[args.indexOf("--until") + 1];
const config = JSON.parse(fs.readFileSync(${JSON.stringify(controlFile)}, "utf8"));
const key = id + "|" + since;
fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({ id, since, until, args }) + "\\n");
const finish = () => {
    if (config.errors?.[key]) {
        process.stderr.write(config.errors[key]);
        process.exitCode = 1;
    } else {
        process.stdout.write(JSON.stringify(config.payloads[key] || { summary: key, items: [] }));
    }
};
if (config.gates?.[key]) {
    const timer = setInterval(() => {
        if (fs.existsSync(config.gates[key])) {
            clearInterval(timer);
            finish();
        }
    }, 10);
    setTimeout(() => { clearInterval(timer); process.exitCode = 1; }, 12000).unref();
} else {
    finish();
}
`, { mode: 0o755 });

    const sunday = timed("sunday", "2026-03-08T11:00:00-04:00", "2026-03-08T12:00:00-04:00");
    const span = (summary) => timed("span", "2026-03-08T23:30:00-04:00", "2026-03-09T00:30:00-04:00", summary);
    const movedSpan = (summary) => timed("span", "2026-03-09T14:00:00-04:00", "2026-03-09T15:00:00-04:00", summary);
    const holiday = allDay("multi-day", "2026-03-07", "2026-03-10");
    const firstWeek = {
        summary: "week-02",
        accessRole: "owner",
        items: [
            timed("monday", "2026-03-02T09:00:00-05:00", "2026-03-02T10:00:00-05:00"),
            timed("ended-midnight", "2026-03-07T23:00:00-05:00", "2026-03-08T00:00:00-05:00"),
            allDay("ended-sunday", "2026-03-06", "2026-03-08"),
            holiday,
            sunday,
            span("old span"),
        ],
    };
    const secondWeek = {
        summary: "week-09",
        accessRole: "owner",
        items: [
            holiday,
            movedSpan("new span"),
            timed("next-monday", "2026-03-09T09:00:00-04:00", "2026-03-09T10:00:00-04:00"),
            timed("tuesday", "2026-03-10T09:00:00-04:00", "2026-03-10T10:00:00-04:00"),
            timed("friday", "2026-03-13T09:00:00-04:00", "2026-03-13T10:00:00-04:00"),
        ],
    };
    const config = {
        payloads: { "alice|2026-03-02": firstWeek, "alice|2026-03-09": secondWeek },
        errors: {},
        gates: {},
    };
    const saveConfig = () => writeFile(controlFile, JSON.stringify(config));
    const calls = async () => {
        try {
            return (await readFile(logFile, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
        } catch (error) {
            if (error.code === "ENOENT") return [];
            throw error;
        }
    };
    await saveConfig();
    const [{ getProfileState }, cache, { presetStore }, { startServer }] = await Promise.all([
        import("./state.mjs"),
        import("./cache.mjs"),
        import("./presets.mjs"),
        import("./server.mjs"),
    ]);
    const servers = [];
    t.after(async () => {
        for (const server of servers) await server.close();
        presetStore.close();
        await presetStore.queue;
        if (original.home === undefined) delete process.env.COPILOT_HOME;
        else process.env.COPILOT_HOME = original.home;
        if (original.binary === undefined) delete process.env.GALI_BIN;
        else process.env.GALI_BIN = original.binary;
        if (original.timeZone === undefined) delete process.env.TZ;
        else process.env.TZ = original.timeZone;
        await rm(directory, { recursive: true, force: true });
    });

    const state = await getProfileState("viewport");
    await state.updateSettings({
        calendars: [{ id: "alice", label: "Alice" }],
        view: "day",
        anchor: "2026-03-03",
    });
    assert.deepEqual((await calls()).map(({ since, until }) => [since, until]), [["2026-03-02", "2026-03-08"]]);
    assert.equal(state.snapshot.calendars[0].events.length, 0);
    const firstFetchedAt = state.snapshot.fetchedAt;

    const server = await startServer({ profile: "viewport", instanceId: "viewport-test" });
    servers.push(server);
    const url = new URL(server.url);
    const post = async (route, body) => {
        const response = await fetch(`${url.origin}${route}?token=${url.searchParams.get("token")}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        assert.equal(response.status, 200);
        return response.json();
    };

    await t.test("a Monday-start week reuses one cached chunk", async () => {
        await post("/api/settings", { settings: { view: "week", anchor: "2026-03-02" } });
        assert.equal(state.snapshot.range.anchor, "2026-03-02");
        assert.equal(state.snapshot.range.since, "2026-03-02");
        assert.equal(state.snapshot.range.until, "2026-03-08");
        assert.deepEqual(state.snapshot.cache, { hits: 1, chunks: 1 });
        await post("/api/settings", { settings: { view: "3days", anchor: "2026-03-06" } });
        assert.deepEqual(state.snapshot.range.days, ["2026-03-06", "2026-03-07", "2026-03-08"]);
        await post("/api/settings", { settings: { view: "day", anchor: "2026-03-03" } });
        assert.equal((await calls()).length, 1);
    });

    await t.test("view switches and dates in a fetched week do not invoke gali", async () => {
        await post("/api/settings", { settings: { view: "3days" } });
        await post("/api/settings", { settings: { view: "week", anchor: "2026-03-02" } });
        await post("/api/settings", { settings: { view: "day", anchor: "2026-03-08" } });
        assert.equal((await calls()).length, 1);
        assert.deepEqual(new Set(state.snapshot.calendars[0].events.map((event) => event.id)),
            new Set(["multi-day", "sunday", "span"]));
        assert.equal(state.snapshot.calendars[0].stats.total, 3);
        assert.deepEqual(state.snapshot.cache, { hits: 1, chunks: 1 });
        assert.equal(state.snapshot.fetchedAt, firstFetchedAt);
    });

    await t.test("a crossing viewport fetches only the missing week and filters exclusive boundaries", async () => {
        await post("/api/settings", { settings: { view: "3days" } });
        assert.deepEqual((await calls()).map(({ since }) => since), ["2026-03-02", "2026-03-09"]);
        assert.deepEqual(state.snapshot.range.days, ["2026-03-08", "2026-03-09", "2026-03-10"]);
        const events = state.snapshot.calendars[0].events;
        assert.deepEqual(new Set(events.map((event) => event.id)),
            new Set(["multi-day", "sunday", "span", "next-monday", "tuesday"]));
        assert.equal(events.filter((event) => event.id === "span").length, 1);
        assert.equal(events.find((event) => event.id === "span").summary, "new span");
        assert.equal(events.find((event) => event.id === "span").start, "2026-03-09T14:00:00-04:00");
        assert.equal(events.filter((event) => event.id === "multi-day").length, 1);
        assert.equal(state.snapshot.fetchedAt, firstFetchedAt);
        assert.deepEqual(state.snapshot.cache, { hits: 1, chunks: 2 });

        await post("/api/settings", { settings: { view: "day", anchor: "2026-03-10" } });
        assert.deepEqual(state.snapshot.calendars[0].events.map((event) => event.id), ["tuesday"]);
        assert.equal((await calls()).length, 2);
    });

    await t.test("rolling weeks reuse both cached chunks and preserve the chosen start", async () => {
        await post("/api/settings", { settings: { view: "week", anchor: "2026-03-04" } });
        assert.deepEqual(state.snapshot.range.days, [
            "2026-03-04", "2026-03-05", "2026-03-06", "2026-03-07", "2026-03-08", "2026-03-09", "2026-03-10",
        ]);
        assert.deepEqual(state.snapshot.cache, { hits: 2, chunks: 2 });
        assert.equal(state.snapshot.fetchedAt, firstFetchedAt);
        const events = state.snapshot.calendars[0].events;
        assert.deepEqual(new Set(events.map((event) => event.id)), new Set([
            "ended-midnight", "ended-sunday", "multi-day", "sunday", "span", "next-monday", "tuesday",
        ]));
        assert.equal(events.filter((event) => event.id === "multi-day").length, 1);
        assert.equal(events.filter((event) => event.id === "span").length, 1);
        assert.equal(events.find((event) => event.id === "span").summary, "new span");

        await post("/api/settings", { settings: { anchor: "2026-03-06" } });
        assert.equal(state.settings.view, "week");
        assert.equal(state.snapshot.range.since, "2026-03-06");
        assert.equal(state.snapshot.range.until, "2026-03-12");
        for (const view of ["day", "3days", "week"]) {
            await post("/api/settings", { settings: { view } });
            assert.equal(state.snapshot.range.since, "2026-03-06");
        }
        assert.equal(state.snapshot.range.until, "2026-03-12");
        assert.equal((await calls()).length, 2);
    });

    await t.test("manual refresh bypasses both weeks and expiry refetches only the stale one", async () => {
        await post("/api/settings", { settings: { view: "3days", anchor: "2026-03-08" } });
        config.payloads["alice|2026-03-02"] = { ...firstWeek, items: [...firstWeek.items.slice(0, -1), span("forced old")] };
        config.payloads["alice|2026-03-09"] = { ...secondWeek, items: secondWeek.items.map(
            (item) => item.id === "span" ? movedSpan("forced new") : item,
        ) };
        await saveConfig();
        await post("/api/refresh", {});
        assert.deepEqual((await calls()).map(({ since }) => since),
            ["2026-03-02", "2026-03-09", "2026-03-02", "2026-03-09"]);
        assert.equal(state.snapshot.calendars[0].events.find((event) => event.id === "span").summary, "forced new");
        assert.deepEqual(state.snapshot.cache, { hits: 0, chunks: 2 });

        for (const name of await readdir(cache.cacheDir)) {
            const file = path.join(cache.cacheDir, name);
            const record = JSON.parse(await readFile(file, "utf8"));
            if (record.value.summary === "week-02") {
                record.at = Date.now() - 16 * 60_000;
                await writeFile(file, JSON.stringify(record));
            }
        }
        cache.clearMemoryCache();
        await post("/api/settings", { settings: { view: "day", anchor: "2026-03-03" } });
        assert.equal((await calls()).length, 5);
        assert.equal((await calls())[4].since, "2026-03-02");
        assert.deepEqual(state.snapshot.cache, { hits: 0, chunks: 1 });
        await post("/api/settings", { settings: { anchor: "2026-03-10" } });
        assert.equal((await calls()).length, 5);
        assert.deepEqual(state.snapshot.cache, { hits: 1, chunks: 1 });
    });

    await t.test("a failed week is visible and cannot produce shared free slots", async () => {
        config.errors["bob|2026-03-09"] = "simulated backend failure";
        await saveConfig();
        const errorState = await getProfileState("viewport-error");
        await errorState.updateSettings({
            calendars: [{ id: "alice", label: "Alice" }, { id: "bob", label: "Bob" }],
            view: "3days",
            anchor: "2026-03-08",
        });
        assert.equal(errorState.snapshot.calendars[0].error, null);
        assert.match(errorState.snapshot.calendars[1].error, /simulated backend failure/);
        assert.deepEqual(errorState.snapshot.calendars[1].events, []);
        assert.deepEqual(errorState.toJSON().freeSlots, []);
    });

    await t.test("scans retain the newer copy of a multi-week event", async () => {
        const longEvent = (end) => timed("long", "2026-03-08T23:00:00-04:00", end);
        const oldEvent = longEvent("2026-03-09T10:00:00-04:00");
        config.payloads["scanner|2026-03-02"] = { summary: "first", items: [oldEvent] };
        config.payloads["scanner|2026-03-09"] = { summary: "second", items: [oldEvent] };
        await saveConfig();
        const scanState = await getProfileState("viewport-scan");
        await scanState.updateSettings({
            calendars: [{ id: "scanner" }],
            view: "3days",
            anchor: "2026-03-08",
            skipHolidays: false,
        });
        config.payloads["scanner|2026-03-02"] = {
            summary: "first",
            items: [longEvent("2026-03-09T12:00:00-04:00")],
        };
        await saveConfig();
        await scanState.updateSettings({ view: "week", anchor: "2026-03-02" }, { refresh: false });
        await scanState.refresh({ force: true });
        const beforeScan = (await calls()).length;
        await scanState.scanAvailability({ from: "2026-03-02", weeks: 2 });
        assert.ok(scanState.scan);
        assert.equal((await calls()).length, beforeScan);
        assert.equal(scanState.scanCalendars[0].events.length, 1);
        assert.equal(scanState.scanCalendars[0].events[0].end, "2026-03-09T12:00:00-04:00");
        assert.deepEqual(busyIntervals(scanState.scanCalendars, "2026-03-09"), [[0, 720]]);
    });

    await t.test("a cached date reappears while a different week is still fetching", async () => {
        const navigation = await getProfileState("viewport-navigation");
        await navigation.updateSettings({
            calendars: [{ id: "charlie" }], view: "day", anchor: "2026-03-03",
        });
        const release = path.join(directory, "release-navigation");
        config.gates["charlie|2026-03-09"] = release;
        await saveConfig();
        const slow = navigation.updateSettings({ anchor: "2026-03-10" });
        try {
            await waitFor(async () => (await calls()).some(
                (call) => call.id === "charlie" && call.since === "2026-03-09",
            ));
            await Promise.race([
                navigation.updateSettings({ anchor: "2026-03-03" }),
                delay(1500).then(() => { throw new Error("cached navigation waited for the slow CLI"); }),
            ]);
            assert.equal(navigation.snapshot.range.anchor, "2026-03-03");
            assert.equal(navigation.snapshot.cache.hits, 1);
            assert.equal(navigation.loading, false);
        } finally {
            await writeFile(release, "");
            await slow;
        }
        assert.equal(navigation.snapshot.range.anchor, "2026-03-03");
        assert.equal(navigation.loading, false);
    });

    await t.test("rolling-week navigation moves seven days and fetches only missing chunks", async () => {
        await post("/api/settings", { settings: { view: "week", anchor: "2026-03-04" } });
        const aliceCalls = async () => (await calls()).filter((call) => call.id === "alice");
        const before = (await aliceCalls()).length;
        await post("/api/navigate", { direction: "next" });
        assert.equal(state.snapshot.range.since, "2026-03-11");
        assert.equal(state.snapshot.range.until, "2026-03-17");
        assert.equal((await aliceCalls()).length, before + 1);
        assert.equal((await aliceCalls()).at(-1).since, "2026-03-16");
        await post("/api/navigate", { direction: "prev" });
        assert.equal(state.snapshot.range.since, "2026-03-04");
        assert.equal(state.snapshot.range.until, "2026-03-10");
        assert.deepEqual(state.snapshot.cache, { hits: 2, chunks: 2 });
        assert.equal((await aliceCalls()).length, before + 1);

        await Promise.all([
            post("/api/navigate", { direction: "next" }),
            post("/api/navigate", { direction: "next" }),
        ]);
        assert.equal(state.settings.anchor, "2026-03-18");
        assert.equal(state.snapshot.range.since, "2026-03-18");
        assert.equal(state.snapshot.range.until, "2026-03-24");
    });

    await t.test("rolling weeks reuse cache chunks across a year boundary", async () => {
        const year = await getProfileState("viewport-year");
        await year.updateSettings({ calendars: [{ id: "year" }], view: "week", anchor: "2026-12-30" });
        const yearCalls = async () => (await calls()).filter((call) => call.id === "year");
        assert.deepEqual((await yearCalls()).map(({ since, until }) => [since, until]), [
            ["2026-12-28", "2027-01-03"], ["2027-01-04", "2027-01-10"],
        ]);
        assert.equal(year.snapshot.range.since, "2026-12-30");
        assert.equal(year.snapshot.range.until, "2027-01-05");
        await year.updateSettings({ anchor: "2026-12-31" });
        assert.equal(year.snapshot.range.since, "2026-12-31");
        assert.equal(year.snapshot.range.until, "2027-01-06");
        assert.deepEqual(year.snapshot.cache, { hits: 2, chunks: 2 });
        assert.equal((await yearCalls()).length, 2);
    });
});
