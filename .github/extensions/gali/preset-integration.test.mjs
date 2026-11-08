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

test("member presets work across profiles, HTTP, and in-flight fetches", { skip: process.platform === "win32" }, async (t) => {
    const directory = await mkdtemp(path.join(tmpdir(), "gali-preset-integration-"));
    const originalHome = process.env.COPILOT_HOME;
    const originalBin = process.env.GALI_BIN;
    const marker = path.join(directory, "started");
    const binary = path.join(directory, "fake-gali");
    process.env.COPILOT_HOME = directory;
    process.env.GALI_BIN = binary;
    await writeFile(binary, `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const id = process.argv[3];
if (id.startsWith("slow-")) appendFileSync(${JSON.stringify(marker)}, id + "\\n");
setTimeout(() => {
    if (id === "slow-fail") {
        process.stderr.write("old fetch failed");
        process.exitCode = 1;
    } else {
        process.stdout.write(JSON.stringify({ summary: id, items: [] }));
    }
}, id.startsWith("slow-") ? 400 : 5);
`, { mode: 0o755 });

    const { getProfileState } = await import("./state.mjs");
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

    const started = async (id) => {
        try {
            return (await readFile(marker, "utf8")).split("\n").includes(id);
        } catch (error) {
            if (error.code === "ENOENT") return false;
            throw error;
        }
    };
    const startCount = async (id) => {
        try {
            return (await readFile(marker, "utf8")).split("\n").filter((line) => line === id).length;
        } catch (error) {
            if (error.code === "ENOENT") return 0;
            throw error;
        }
    };
    const alice = { id: "slow-alice", label: "Alice" };
    const bob = { id: "bob", label: "Bob" };
    const alpha = await getProfileState("team-a");
    const beta = await getProfileState("team-b");
    await alpha.updateSettings({ calendars: [alice, bob] }, { refresh: false });
    await beta.updateSettings({
        calendars: [{ id: "before", label: "" }],
        view: "day",
        anchor: "2026-11-02",
        workStart: "08:15",
        skipHolidays: false,
    }, { refresh: false });
    await beta.refresh();

    const notifications = [];
    const unsubscribe = beta.subscribe((data) => notifications.push(data));
    t.after(unsubscribe);
    const saved = await alpha.createMemberPreset("開発チーム");
    assert.ok(beta.toJSON().presets.some((preset) => preset.id === saved.id));
    assert.ok(notifications.some((data) => data.presets.some((preset) => preset.id === saved.id)));

    await t.test("applying replaces only the target profile and never publishes an old fetch", async () => {
        const oldFetch = beta.updateSettings({ calendars: [{ id: "slow-fail", label: "" }] });
        await waitFor(() => started("slow-fail"));
        beta.scan = { fetchedAt: "old" };
        beta.scanIndex = { old: true };
        const applying = beta.applyMemberPreset(saved.id);
        await waitFor(() => beta.settings.calendars[0]?.id === "slow-alice");
        assert.equal(beta.snapshot, null);
        assert.equal(beta.scan, null);
        assert.equal(beta.scanIndex, null);
        await Promise.all([oldFetch, applying]);
        assert.deepEqual(beta.settings.calendars, [alice, bob]);
        assert.equal(beta.settings.view, "day");
        assert.equal(beta.settings.workStart, "08:15");
        assert.deepEqual(beta.snapshot.calendars.map((calendar) => calendar.id), ["slow-alice", "bob"]);
        assert.equal(beta.error, null);
        assert.deepEqual(alpha.settings.calendars, [alice, bob]);
        for (const data of notifications.filter((entry) => entry.settings.calendars[0]?.id === "slow-alice")) {
            if (data.snapshot) {
                assert.deepEqual(data.snapshot.calendars.map((calendar) => calendar.id), ["slow-alice", "bob"]);
            }
        }
    });

    await t.test("an obsolete scan stops publishing progress, results, and errors", async () => {
        await beta.updateSettings({ calendars: [{ id: "slow-scan", label: "" }] }, { refresh: false });
        const scan = beta.scanAvailability({ weeks: 1, from: "2026-11-02" }, { force: true });
        await waitFor(() => started("slow-scan"));
        const queuedScan = beta.scanAvailability({ weeks: 2, from: "2026-11-02" }, { force: true });
        assert.ok(beta.scanProgress);
        const applying = beta.applyMemberPreset(saved.id);
        await waitFor(() => beta.settings.calendars[0]?.id === "slow-alice");
        assert.equal(beta.scanProgress, null);
        await Promise.all([scan, queuedScan, applying]);
        assert.equal(beta.scan, null);
        assert.equal(beta.scanProgress, null);
        assert.equal(beta.error, null);
    });

    await t.test("same calendar IDs with changed labels cannot reuse an old fetch", async () => {
        const before = await startCount("slow-alice");
        const oldFetch = beta.updateSettings({
            calendars: [{ ...alice, label: "Old name" }, bob],
            refs: ["label-race-reference"],
        });
        await waitFor(async () => (await startCount("slow-alice")) > before);
        const applying = beta.applyMemberPreset(saved.id);
        await Promise.all([oldFetch, applying]);
        assert.equal(beta.settings.calendars[0].label, "Alice");
        assert.equal(beta.snapshot.calendars[0].label, "Alice");
    });

    await t.test("authenticated HTTP operations notify other profiles and keep applied members after deletion", async () => {
        const first = await startServer({ profile: "team-a", instanceId: "test-a" });
        const second = await startServer({ profile: "team-b", instanceId: "test-b" });
        servers.push(first, second);
        const firstUrl = new URL(first.url);
        const secondUrl = new URL(second.url);
        const endpoint = (url, route) => `${url.origin}${route}?token=${url.searchParams.get("token")}`;
        const request = async (url, route, body) => {
            const response = await fetch(endpoint(url, route), {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            return { status: response.status, body: await response.json() };
        };
        const denied = await fetch(`${firstUrl.origin}/api/bootstrap`);
        assert.equal(denied.status, 403);
        assert.equal((await request(firstUrl, "/api/presets/create", { name: " " })).status, 400);
        assert.equal((await request(firstUrl, "/api/presets/apply", { id: "../bad" })).status, 400);

        const controller = new AbortController();
        const response = await fetch(endpoint(secondUrl, "/events"), { signal: controller.signal });
        const reader = response.body.getReader();
        await reader.read();
        const result = await request(firstUrl, "/api/presets/create", { name: "HTTP チーム" });
        assert.equal(result.status, 200);
        let timeout;
        const nextFrame = await Promise.race([
            reader.read(),
            new Promise((_, reject) => {
                timeout = setTimeout(() => reject(new Error("no preset SSE update")), 3000);
            }),
        ]).finally(() => clearTimeout(timeout));
        assert.match(new TextDecoder().decode(nextFrame.value), /HTTP チーム/);
        controller.abort();

        const bootstrap = await (await fetch(endpoint(secondUrl, "/api/bootstrap"))).json();
        assert.ok(bootstrap.presets.some((preset) => preset.id === result.body.preset.id));
        await beta.updateSettings({ calendars: [bob] }, { refresh: false });
        const applied = await request(secondUrl, "/api/presets/apply", { id: result.body.preset.id });
        assert.equal(applied.status, 200);
        assert.deepEqual(applied.body.settings.calendars, [alice, bob]);
        assert.equal(applied.body.snapshot, null);
        await waitFor(() => beta.snapshot && !beta.loading);
        const before = beta.settings.calendars;
        const removed = await request(firstUrl, "/api/presets/delete", { id: result.body.preset.id });
        assert.equal(removed.status, 200);
        assert.deepEqual(beta.settings.calendars, before);
        assert.equal((await request(firstUrl, "/api/presets/delete", { id: result.body.preset.id })).status, 404);
    });
});
