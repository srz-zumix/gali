import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

async function waitFor(predicate) {
    const deadline = Date.now() + 5000;
    while (!(await predicate())) {
        if (Date.now() > deadline) throw new Error("timed out waiting for the test state");
        await delay(15);
    }
}

test("calendar ordering persists and preserves current work", { skip: process.platform === "win32" }, async (t) => {
    const directory = await mkdtemp(path.join(tmpdir(), "gali-calendar-order-"));
    const originalHome = process.env.COPILOT_HOME;
    const originalBin = process.env.GALI_BIN;
    const marker = path.join(directory, "calls");
    const binary = path.join(directory, "fake-gali");
    process.env.COPILOT_HOME = directory;
    process.env.GALI_BIN = binary;
    await writeFile(binary, `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const id = process.argv[3];
appendFileSync(${JSON.stringify(marker)}, id + "\\n");
setTimeout(() => {
    process.stdout.write(JSON.stringify({ summary: id, items: [] }));
}, id.startsWith("slow-") ? 400 : 5);
`, { mode: 0o755 });

    const { getProfileState } = await import("./state.mjs");
    const { loadSettings } = await import("./store.mjs");
    const { presetStore } = await import("./presets.mjs");
    const { startServer } = await import("./server.mjs");
    const servers = [];
    t.after(async () => {
        for (const server of servers) await server.close();
        presetStore.close();
        await presetStore.queue;
        if (originalHome === undefined) delete process.env.COPILOT_HOME;
        else process.env.COPILOT_HOME = originalHome;
        if (originalBin === undefined) delete process.env.GALI_BIN;
        else process.env.GALI_BIN = originalBin;
        await rm(directory, { recursive: true, force: true });
    });

    const calls = async () => {
        try {
            return (await readFile(marker, "utf8")).split("\n").filter(Boolean);
        } catch (error) {
            if (error.code === "ENOENT") return [];
            throw error;
        }
    };
    const callCount = async (id) => (await calls()).filter((value) => value === id).length;
    const ids = (entries) => entries.map((entry) => entry.id);
    const alice = { id: "alice", label: "Alice" };
    const bob = { id: "bob", label: "Bob" };
    const charlie = { id: "charlie", label: "Charlie" };
    const state = await getProfileState("ordering");
    await state.updateSettings({
        calendars: [alice, bob, charlie], view: "day", anchor: "2026-11-02", skipHolidays: false,
    }, { refresh: false });
    await state.refresh();
    await state.scanAvailability({ weeks: 1, from: "2026-11-02" }, { force: true });

    await t.test("reorders cached results, preserves scans, and saves the ordered preset", async () => {
        const beforeCalls = await calls();
        const fetchedAt = state.snapshot.fetchedAt;
        const scanAt = state.scan.fetchedAt;
        const index = state.scanIndex;
        const generation = state.scanGeneration;
        const colors = new Map(state.snapshot.calendars.map((calendar) => [calendar.id, calendar.color]));
        await state.moveCalendar({ id: "charlie", targetId: "alice", position: "before" });
        assert.deepEqual(ids(state.settings.calendars), ["charlie", "alice", "bob"]);
        assert.deepEqual(ids(state.snapshot.calendars), ["charlie", "alice", "bob"]);
        assert.deepEqual(ids(state.scan.calendars), ["charlie", "alice", "bob"]);
        assert.equal(state.snapshot.fetchedAt, fetchedAt);
        assert.equal(state.scan.fetchedAt, scanAt);
        assert.equal(state.scanIndex, index);
        assert.equal(state.scanGeneration, generation);
        assert.deepEqual(new Map(state.snapshot.calendars.map((calendar) => [calendar.id, calendar.color])), new Map([
            ["charlie", colors.get("charlie")], ["alice", colors.get("alice")], ["bob", colors.get("bob")],
        ]));
        assert.deepEqual(await calls(), beforeCalls);
        assert.deepEqual((await loadSettings("ordering")).calendars, [charlie, alice, bob]);

        const preset = await state.createMemberPreset("順序付き");
        assert.deepEqual(preset.calendars, [charlie, alice, bob]);
        const other = await getProfileState("ordering-other");
        await other.updateSettings({ calendars: [bob], skipHolidays: false }, { refresh: false });
        await other.applyMemberPreset(preset.id);
        assert.deepEqual(other.settings.calendars, [charlie, alice, bob]);
        assert.deepEqual(ids(other.snapshot.calendars), ["charlie", "alice", "bob"]);
    });

    await t.test("sharing mode persists across panels without fetching or invalidating the scan", async () => {
        const first = await startServer({ profile: "ordering", instanceId: "share-first" });
        const second = await startServer({ profile: "ordering", instanceId: "share-second" });
        servers.push(first, second);
        const endpoint = (server, route) => {
            const url = new URL(server.url);
            return `${url.origin}${route}?token=${url.searchParams.get("token")}`;
        };
        const post = async (server, enabled) => {
            const response = await fetch(endpoint(server, "/api/settings"), {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ settings: { shareMode: enabled }, refresh: false }),
            });
            assert.equal(response.status, 200);
            return response.json();
        };
        const beforeCalls = await calls();
        const fetchedAt = state.snapshot.fetchedAt;
        const scanAt = state.scan.fetchedAt;
        const scanIndex = state.scanIndex;
        const scanGeneration = state.scanGeneration;
        const notifications = [];
        const unsubscribe = state.subscribe((payload) => notifications.push(payload.settings.shareMode));
        t.after(unsubscribe);

        assert.equal((await loadSettings("ordering")).shareMode, false);
        assert.equal((await post(first, true)).settings.shareMode, true);
        assert.equal((await loadSettings("ordering")).shareMode, true);
        assert.equal((await (await fetch(endpoint(second, "/api/bootstrap"))).json()).settings.shareMode, true);
        assert.equal(state.snapshot.fetchedAt, fetchedAt);
        assert.equal(state.scan.fetchedAt, scanAt);
        assert.equal(state.scanIndex, scanIndex);
        assert.equal(state.scanGeneration, scanGeneration);
        assert.deepEqual(await calls(), beforeCalls);
        assert.equal((await post(second, false)).settings.shareMode, false);
        assert.equal((await loadSettings("ordering")).shareMode, false);
        assert.deepEqual(notifications, [true, false]);
        assert.deepEqual(await calls(), beforeCalls);
    });

    await t.test("HTTP moves validate current IDs and merge with concurrent settings edits", async () => {
        const server = await startServer({ profile: "ordering", instanceId: "order-test" });
        servers.push(server);
        const url = new URL(server.url);
        const endpoint = (route) => `${url.origin}${route}?token=${url.searchParams.get("token")}`;
        const request = async (body) => {
            const response = await fetch(endpoint("/api/calendars/move"), {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            return { status: response.status, body: await response.json() };
        };
        const revisions = [];
        const unsubscribe = state.subscribe((payload) => revisions.push(payload.revision));
        t.after(unsubscribe);

        assert.equal((await request({ id: "alice", direction: "up" })).status, 400);
        assert.equal((await request({ id: "alice", targetId: "missing", position: "before" })).status, 409);
        assert.equal((await request({ id: "missing", direction: "left" })).status, 409);
        assert.deepEqual(ids(state.settings.calendars), ["charlie", "alice", "bob"]);

        const moved = await request({ id: "charlie", targetId: "bob", position: "after" });
        assert.equal(moved.status, 200);
        assert.deepEqual(ids(moved.body.settings.calendars), ["alice", "bob", "charlie"]);
        assert.deepEqual(ids(moved.body.snapshot.calendars), ["alice", "bob", "charlie"]);
        assert.equal(moved.body.revision, state.revision);
        const same = await request({ id: "bob", targetId: "bob", position: "before" });
        assert.equal(same.status, 200);
        assert.deepEqual(ids(state.settings.calendars), ["alice", "bob", "charlie"]);

        const added = { id: "dave", label: "Dave" };
        await Promise.all([
            state.updateSettings((settings) => ({ calendars: [...settings.calendars, added] }), { refresh: false }),
            state.moveCalendar({ id: "alice", direction: "right" }),
        ]);
        assert.deepEqual(ids(state.settings.calendars), ["bob", "alice", "charlie", "dave"]);
        assert.ok(revisions.every((revision, index) => index === 0 || revision > revisions[index - 1]));
    });

    await t.test("an in-flight fetch is reused and publishes in the latest order", async () => {
        const loading = await getProfileState("ordering-fetch");
        const slow = { id: "slow-fetch", label: "Slow" };
        await loading.updateSettings({ calendars: [slow, bob], view: "day", skipHolidays: false }, { refresh: false });
        const first = loading.refresh();
        await waitFor(async () => (await callCount("slow-fetch")) === 1);
        const generation = loading.fetchGeneration;
        await loading.moveCalendar({ id: "bob", direction: "left" });
        assert.equal(loading.fetchGeneration, generation);
        const second = loading.refresh();
        await Promise.all([first, second]);
        assert.deepEqual(ids(loading.snapshot.calendars), ["bob", "slow-fetch"]);
        assert.equal(await callCount("slow-fetch"), 1);
    });

    await t.test("an in-flight scan survives reordering but not a label change", async () => {
        const scanning = await getProfileState("ordering-scan");
        const slow = { id: "slow-scan-order", label: "Slow" };
        await scanning.updateSettings({ calendars: [slow, bob], skipHolidays: false }, { refresh: false });
        const params = { weeks: 1, from: "2026-11-02" };
        const first = scanning.scanAvailability(params, { force: true });
        await waitFor(async () => (await callCount("slow-scan-order")) === 1);
        const generation = scanning.scanGeneration;
        await scanning.moveCalendar({ id: "bob", direction: "left" });
        assert.equal(scanning.scanGeneration, generation);
        assert.ok(scanning.scanProgress);
        const second = scanning.scanAvailability(params);
        await Promise.all([first, second]);
        assert.deepEqual(ids(scanning.scan.calendars), ["bob", "slow-scan-order"]);
        assert.equal(await callCount("slow-scan-order"), 1);
        assert.ok(scanning.scanIndex);

        await scanning.updateSettings({ calendars: [bob, { ...slow, label: "New name" }] }, { refresh: false });
        assert.equal(scanning.scan, null);
        assert.equal(scanning.scanIndex, null);
    });
});
