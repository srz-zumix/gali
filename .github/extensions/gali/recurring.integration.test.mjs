import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

test("existing-scan recurring searches and relocation use the exact scan without fetching", async (t) => {
    const directory = await mkdtemp(path.join(tmpdir(), "gali-recurring-test-"));
    const originalHome = process.env.COPILOT_HOME;
    process.env.COPILOT_HOME = directory;
    const [{ getProfileState }, { startServer }, { presetStore }] = await Promise.all([
        import("./state.mjs"),
        import("./server.mjs"),
        import("./presets.mjs"),
    ]);
    let server;
    t.after(async () => {
        if (server) await server.close();
        presetStore.close();
        await presetStore.queue;
        if (originalHome === undefined) delete process.env.COPILOT_HOME;
        else process.env.COPILOT_HOME = originalHome;
        await rm(directory, { recursive: true, force: true });
    });

    const occurrence = (day, id, series) => ({
        id, uid: "shared@example.test", summary: "Existing meeting", detailsVisible: true,
        start: `${day}T10:00:00`, end: `${day}T10:30:00`, durationMinutes: 30,
        recurring: true, recurringEventId: series, allDay: false,
    });
    const ambiguous = (series) => ({
        id: "local-id", uid: "local-id", summary: "Ambiguous meeting", detailsVisible: true,
        start: "2026-01-06T10:00:00", end: "2026-01-06T10:30:00", durationMinutes: 30,
        recurring: true, recurringEventId: series, allDay: false,
    });
    const events = {
        alice: [
            occurrence("2026-01-05", "a1", "alice-series"),
            occurrence("2026-01-12", "a2", "alice-series"),
            ambiguous("alice-other"),
            {
                id: "another", uid: "another", summary: "Other", detailsVisible: true,
                start: "2026-01-12T10:30:00", end: "2026-01-12T11:00:00",
                durationMinutes: 30, allDay: false,
            },
        ],
        bob: [occurrence("2026-01-05", "b1", "bob-series"), ambiguous("bob-other")],
    };
    const state = await getProfileState("recurring-integration");
    let fetches = 0;
    state.fetchCalendarWeek = async (id, since, until) => {
        fetches += 1;
        return {
            events: (events[id] || []).filter((item) => item.start.slice(0, 10) >= since && item.start.slice(0, 10) <= until),
            fetchedAt: new Date().toISOString(),
            cached: false,
        };
    };
    state.pruneCache = async () => {};
    await state.updateSettings({
        calendars: [{ id: "alice", label: "Alice" }, { id: "bob", label: "Bob" }],
        workStart: "10:00", workEnd: "11:00", skipHolidays: false,
    }, { refresh: false });
    const scan = await state.scanAvailability({ from: "2026-01-05", weeks: 4, durationMinutes: 30 });
    assert.ok(scan.id);
    assert.equal(scan.recurringMeetings.length, 2);
    const seriesIndex = scan.recurringMeetings.findIndex((meeting) => meeting.title === "Existing meeting");
    const ambiguousIndex = scan.recurringMeetings.findIndex((meeting) => meeting.title === "Ambiguous meeting");
    assert.equal(scan.recurringMeetings[seriesIndex].occurrences, 2);
    assert.deepEqual(scan.recurringMeetings[seriesIndex].attendees, ["alice", "bob"]);
    assert.deepEqual(scan.recurringMeetings[seriesIndex].durations, [30]);
    assert.equal(scan.recurringMeetings[ambiguousIndex].identified, false);

    server = await startServer({ profile: "recurring-integration", instanceId: "recurring-test" });
    const endpoint = new URL(server.url);
    endpoint.pathname = "/api/recurring";
    const post = (body) => fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    const before = fetches;
    const request = { scanId: scan.id, recurrence: "weekly", durationMinutes: 60, seriesIndex };
    const response = await post(request);
    assert.equal(response.status, 200);
    const result = (await response.json()).recurring;
    const monday = result.candidates.find((item) => item.pattern.weekday === 1 && item.start === "10:00");
    assert.equal(monday.expectedCount, 4);
    assert.equal(monday.freeCount, 3);
    assert.equal(monday.busyCount, 1);
    assert.deepEqual(monday.occurrences.map((item) => item.status), ["free", "busy", "free", "free"]);
    assert.equal(fetches, before);

    for (const [body, code] of [
        [{ ...request, recurrence: "invalid" }, "invalid_recurrence"],
        [{ ...request, durationMinutes: 0 }, "invalid_duration"],
        [{ ...request, seriesIndex: 99 }, "invalid_series"],
        [{ ...request, seriesIndex: ambiguousIndex }, "unidentified_series"],
        [{ ...request, scanId: "old-scan" }, "scan_stale"],
    ]) {
        const rejected = await post(body);
        assert.equal(rejected.status, 400);
        assert.equal((await rejected.json()).code, code);
    }
    const fresh = await state.scanAvailability({ from: "2026-01-05", weeks: 4, durationMinutes: 30 }, { force: true });
    assert.notEqual(fresh.id, scan.id);
    const stale = await post(request);
    assert.equal(stale.status, 400);
    assert.equal((await stale.json()).code, "scan_stale");
});
