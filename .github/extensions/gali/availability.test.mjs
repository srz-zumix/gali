import assert from "node:assert/strict";
import { test } from "node:test";

import { buildIndex, findSharedMeetings, findSlots, scanSlots } from "./analysis.mjs";
import { busyIntervals, busySegments, computeFreeSlots, isBusyEvent } from "./freebusy.mjs";
import { DEFAULT_SETTINGS } from "./store.mjs";

const DAY = "2026-10-05";

function event(id, from, until, responseStatus, extra = {}) {
    const start = `${DAY}T${from}:00`;
    const end = `${DAY}T${until}:00`;
    return {
        id,
        uid: id,
        summary: id,
        detailsVisible: true,
        start,
        end,
        durationMinutes: (new Date(end) - new Date(start)) / 60_000,
        allDay: false,
        transparency: "",
        responseStatus,
        ...extra,
    };
}

const calendar = {
    id: "owner@example.com",
    label: "Owner",
    events: [
        event("accepted", "10:00", "11:00", "accepted"),
        event("declined", "12:00", "13:00", "declined"),
        event("transparent", "14:00", "15:00", "accepted", { transparency: "transparent" }),
        event("all-day", "00:00", "23:59", "accepted", { allDay: true }),
        event("tentative", "15:00", "16:00", "tentative"),
        event("unknown", "16:00", "17:00", ""),
    ],
};

test("declined events do not block availability even when displayed", () => {
    assert.equal(isBusyEvent(calendar.events[0]), true);
    assert.equal(isBusyEvent(calendar.events[1]), false);
    assert.equal(isBusyEvent(calendar.events[2]), false);
    assert.equal(isBusyEvent(calendar.events[3]), false);
    assert.equal(isBusyEvent(calendar.events[4]), true);
    assert.equal(isBusyEvent(calendar.events[5]), true);
    assert.deepEqual(busyIntervals([calendar], DAY), [[600, 660], [900, 1020]]);
    assert.deepEqual(busySegments([calendar], DAY).map(segment => segment.event.id), [
        "accepted", "tentative", "unknown",
    ]);
});

test("showing declined events leaves common free slots unchanged", () => {
    const snapshot = { calendars: [calendar], range: { days: [DAY] } };
    const hidden = computeFreeSlots(snapshot, { ...DEFAULT_SETTINGS, showDeclined: false });
    const shown = computeFreeSlots(snapshot, { ...DEFAULT_SETTINGS, showDeclined: true });
    assert.deepEqual(shown, hidden);
    assert.deepEqual(shown, [{
        day: DAY,
        slots: [[540, 600], [660, 900], [1020, 1080]],
    }]);
});

test("availability scans ignore declined events independently of the display toggle", () => {
    for (const showDeclined of [false, true]) {
        const index = buildIndex([calendar], [DAY], { ...DEFAULT_SETTINGS, showDeclined });
        assert.deepEqual([...index.meetings.values()].map(meeting => meeting.uid), [
            "accepted", "tentative", "unknown",
        ]);
        assert.equal(index.byDay.get(DAY).length, 3);
    }
});

test("a declined attendee is not a blocker or a shared-meeting participant", () => {
    const calendars = [
        { id: "owner@example.com", events: [event("shared", "10:00", "11:00", "declined")] },
        { id: "teammate@example.com", events: [event("shared", "10:00", "11:00", "accepted")] },
    ];
    // A fixed past date, so the scan has to be told to look at history.
    const settings = { ...DEFAULT_SETTINGS, showDeclined: true, participantCount: 2, includePast: true };
    const index = buildIndex(calendars, [DAY], settings);
    const meeting = [...index.meetings.values()][0];
    assert.deepEqual([...meeting.attendees], ["teammate@example.com"]);
    assert.deepEqual(findSharedMeetings(index, { minAttendees: 2 }), []);
    const slots = scanSlots(index, [DAY], settings, { durationMinutes: 30 });
    const blocked = slots.find(slot => slot.start === 600);
    assert.deepEqual(blocked.blockers.map(blocker => blocker.calendarId), ["teammate@example.com"]);
    const result = findSlots(index, [DAY], settings, { durationMinutes: 30 });
    assert.ok(result.candidates.every(candidate => candidate.adjacentMeeting === null));
});

test("a scan started today does not propose start times that have passed", () => {
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const settings = { ...DEFAULT_SETTINGS, workStart: "00:00", workEnd: "23:30" };
    const index = buildIndex([{ id: "owner@example.com", events: [] }], [today], settings);
    const slots = scanSlots(index, [today], settings, { durationMinutes: 30 });
    const cutoff = now.getHours() * 60 + now.getMinutes();
    assert.ok(slots.every((slot) => slot.start >= cutoff));
    assert.ok(scanSlots(index, [today], { ...settings, includePast: true }, { durationMinutes: 30 }).some(
        (slot) => slot.start === 0,
    ));
});
