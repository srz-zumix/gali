import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { collectCalendar, GaliError, resolveGaliBinary } from "./gali.mjs";

test("gali binary selection", async (t) => {
    const directory = await mkdtemp(path.join(tmpdir(), "gali-binary-test-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const localPath = path.join(directory, "gali");
    await writeFile(localPath, "");

    await t.test("prefers the repository binary", async () => {
        assert.equal(await resolveGaliBinary({ localPath, override: "" }), localPath);
    });

    await t.test("honors an explicit override even when the local binary exists", async () => {
        const override = path.join(directory, "custom-gali");
        assert.equal(await resolveGaliBinary({ localPath, override }), override);
    });

    await t.test("falls back to PATH only when the local binary is missing", async () => {
        assert.equal(
            await resolveGaliBinary({ localPath: path.join(directory, "missing"), override: "" }),
            "gali",
        );
    });

    await t.test("does not silently fall back for an invalid local binary", async () => {
        const invalidPath = path.join(directory, "not-a-binary");
        await mkdir(invalidPath);
        await assert.rejects(
            resolveGaliBinary({ localPath: invalidPath, override: "" }),
            GaliError,
        );
    });

    await t.test("detects a binary built after an earlier fallback", async () => {
        const newPath = path.join(directory, "new-gali");
        assert.equal(await resolveGaliBinary({ localPath: newPath, override: "" }), "gali");
        await writeFile(newPath, "");
        assert.equal(await resolveGaliBinary({ localPath: newPath, override: "" }), newPath);
    });
});

test("cached calendars are separated by CLI binary", { skip: process.platform === "win32" }, async (t) => {
    const directory = await mkdtemp(path.join(tmpdir(), "gali-cache-test-"));
    const originalHome = process.env.COPILOT_HOME;
    const originalBin = process.env.GALI_BIN;
    t.after(async () => {
        if (originalHome === undefined) delete process.env.COPILOT_HOME;
        else process.env.COPILOT_HOME = originalHome;
        if (originalBin === undefined) delete process.env.GALI_BIN;
        else process.env.GALI_BIN = originalBin;
        await rm(directory, { recursive: true, force: true });
    });

    process.env.COPILOT_HOME = directory;
    const { fetchWeek } = await import("./cache.mjs?binary-selection-test");

    const first = path.join(directory, "first-gali");
    const second = path.join(directory, "second-gali");
    for (const [file, summary] of [[first, "first"], [second, "second"]]) {
        await writeFile(file, `#!/bin/sh\nprintf '%s\\n' '{"summary":"${summary}","items":[]}'\n`, { mode: 0o755 });
    }

    const fetch = () => fetchWeek("calendar@example.com", "2026-10-05", "2026-10-11");
    process.env.GALI_BIN = first;
    const firstResult = await fetch();
    assert.equal(firstResult.summary, "first");
    assert.equal(firstResult.cached, false);
    assert.equal((await fetch()).cached, true);

    process.env.GALI_BIN = second;
    const secondResult = await fetch();
    assert.equal(secondResult.summary, "second");
    assert.equal(secondResult.cached, false);

    process.env.GALI_BIN = first;
    const reused = await fetch();
    assert.equal(reused.summary, "first");
    assert.equal(reused.cached, true);
});

test("completion provenance is normalized and retained in caches", { skip: process.platform === "win32" }, async (t) => {
    const directory = await mkdtemp(path.join(tmpdir(), "gali-completion-test-"));
    const originalHome = process.env.COPILOT_HOME;
    const originalBin = process.env.GALI_BIN;
    t.after(async () => {
        if (originalHome === undefined) delete process.env.COPILOT_HOME;
        else process.env.COPILOT_HOME = originalHome;
        if (originalBin === undefined) delete process.env.GALI_BIN;
        else process.env.GALI_BIN = originalBin;
        await rm(directory, { recursive: true, force: true });
    });
    process.env.COPILOT_HOME = directory;
    const binary = path.join(directory, "gali");
    process.env.GALI_BIN = binary;
    const options = { since: "2026-10-05", until: "2026-10-11" };
    const writePayload = async (accessRole, visibility, completedFrom, allDay = false, completedFromName = "") => {
        const data = {
            accessRole,
            items: [{
                id: "meeting",
                summary: "Meeting",
                visibility,
                start: allDay ? { date: "2026-10-05" } : { dateTime: "2026-10-05T09:00:00+09:00" },
                end: allDay ? { date: "2026-10-06" } : { dateTime: "2026-10-05T10:00:00+09:00" },
                attendees: [{ self: true, responseStatus: "declined" }],
                ...(completedFrom ? { extendedProperties: { private: {
                    "gali.completedFrom": completedFrom,
                    ...(completedFromName ? { "gali.completedFromName": completedFromName } : {}),
                } } } : {}),
            }],
        };
        await writeFile(binary, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify(data))});\n`, { mode: 0o755 });
    };

    for (const [role, visibility, source, allDay, inferred, sourceName] of [
        ["owner", "private", "source@example.com", false, false, "Source calendar"],
        ["writer", "private", "source@example.com", true, false, "Source calendar"],
        ["reader", "default", "room@example.com", false, false, "Room One"],
        ["freeBusyReader", "public", "room@example.com", false, false, "Room One"],
        ["reader", "default", "room@example.com", false, false, ""],
        ["reader", "private", "", false, true, ""],
        ["owner", "private", "", false, false, ""],
    ]) {
        await writePayload(role, visibility, source, allDay, sourceName);
        const result = await collectCalendar("target@example.com", options);
        const event = result.events[0];
        assert.equal(event.completedFrom, source);
        assert.equal(event.completedFromName, sourceName);
        assert.equal(event.completed, Boolean(source) || inferred);
        assert.equal(event.completionInferred, inferred);
        assert.equal(event.allDay, allDay);
        assert.equal(event.responseStatus, "declined");
    }

    const { fetchWeek, clearMemoryCache, cacheDir } = await import("./cache.mjs?completion-source-test");
    const oldKey = createHash("sha1").update([
        "v4", binary, "target@example.com", options.since, options.until, "", "", "",
    ].join("\u0000")).digest("hex");
    await mkdir(cacheDir, { recursive: true });
    await writeFile(path.join(cacheDir, `${oldKey}.json`), JSON.stringify({ summary: "stale", events: [] }));
    await writePayload("reader", "default", "source@example.com", false, "Source calendar");
    const fetch = () => fetchWeek("target@example.com", options.since, options.until);
    const fresh = await fetch();
    assert.equal(fresh.cached, false);
    assert.equal(fresh.events[0].completedFrom, "source@example.com");
    assert.equal(fresh.events[0].completedFromName, "Source calendar");
    assert.equal((await fetch()).events[0].completedFrom, "source@example.com");
    assert.equal((await fetch()).events[0].completedFromName, "Source calendar");
    clearMemoryCache();
    const disk = await fetch();
    assert.equal(disk.cached, true);
    assert.equal(disk.events[0].completedFrom, "source@example.com");
    assert.equal(disk.events[0].completedFromName, "Source calendar");
    assert.equal(disk.events[0].completionInferred, false);
});
