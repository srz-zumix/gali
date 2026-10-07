import assert from "node:assert/strict";
import { test } from "node:test";

import { buildSharedEventGroups, calendarEventKey, eventKey } from "./ui/meetings.mjs";

const START = "2026-10-05T18:00:00+09:00";
const event = (id, extra = {}) => ({ id, uid: id, start: START, responseStatus: "", ...extra });
const calendar = (id, events, extra = {}) => ({ id, label: id, events, ...extra });
const entry = (groups, calendarId, eventId) => groups.get(calendarEventKey(calendarId, eventId));

test("private copies with the same event ID get one shared group", () => {
    const calendars = [
        calendar("alice", [event("meeting", { detailsVisible: false })], { label: "Alice" }),
        calendar("bob", [event("meeting", { detailsVisible: false })], { label: "Bob" }),
    ];
    const groups = buildSharedEventGroups(calendars);
    assert.equal(groups.size, 2);
    assert.equal(entry(groups, "alice", "meeting"), entry(groups, "bob", "meeting"));
    assert.deepEqual(entry(groups, "alice", "meeting"), {
        number: 1,
        calendars: [{ id: "alice", label: "Alice" }, { id: "bob", label: "Bob" }],
    });
});

test("iCalUID and equivalent start instants match copies with different IDs", () => {
    const a = event("a", { uid: "invitation@example.com" });
    const b = event("b", { uid: a.uid, start: "2026-10-05T09:00:00Z" });
    assert.equal(eventKey(a), eventKey(b));
    const groups = buildSharedEventGroups([calendar("alice", [a]), calendar("bob", [b])]);
    assert.equal(entry(groups, "alice", "a"), entry(groups, "bob", "b"));
    assert.equal(groups.size, 2);
});

test("an ID-only copy and a UID copy can bridge previously separate groups", () => {
    const calendars = [
        calendar("alice", [event("a", { uid: "invitation@example.com" })]),
        calendar("bob", [event("b")]),
        calendar("carol", [event("b", { uid: "invitation@example.com" })]),
    ];
    for (const order of [calendars, [...calendars].reverse()]) {
        const groups = buildSharedEventGroups(order);
        const group = entry(groups, "alice", "a");
        assert.equal(group, entry(groups, "bob", "b"));
        assert.equal(group, entry(groups, "carol", "b"));
        assert.equal(group.calendars.length, 3);
        assert.equal(groups.size, 3);
    }
});

test("coincident times, titles, missing identifiers, and invalid starts do not match", () => {
    const events = [
        event("a", { summary: "Same title" }),
        event("b", { summary: "Same title" }),
        event("", { uid: "" }),
        event("invalid", { start: "invalid" }),
        event("missing", { start: "" }),
    ];
    const groups = buildSharedEventGroups([
        calendar("alice", events),
        calendar("bob", events.filter((item) => !["a", "b"].includes(item.id))),
        // A normalized ID fallback must not masquerade as somebody else's UID.
        calendar("carol", [event("c", { uid: "a" })]),
    ]);
    assert.equal(groups.size, 0);
});

test("recurring occurrences stay separate and numbering is chronological and order-independent", () => {
    const first = event("series_1", { uid: "series@example.com" });
    const second = event("series_2", { uid: first.uid, start: "2026-10-12T18:00:00+09:00" });
    const calendars = [
        calendar("alice", [second, first]),
        calendar("bob", [first, second]),
    ];
    for (const order of [calendars, [...calendars].reverse()]) {
        const groups = buildSharedEventGroups(order);
        const one = entry(groups, "alice", first.id);
        const two = entry(groups, "alice", second.id);
        assert.equal(one, entry(groups, "bob", first.id));
        assert.equal(two, entry(groups, "bob", second.id));
        assert.notEqual(one, two);
        assert.equal(one.number, 1);
        assert.equal(two.number, 2);
    }
    const differentOccurrences = buildSharedEventGroups([
        calendar("alice", [first]),
        calendar("bob", [{ ...first, start: second.start }]),
    ]);
    assert.equal(differentOccurrences.size, 0);
});

test("declined, cancelled, and errored calendars do not count as matching participants", () => {
    const calendars = [
        calendar("alice", [event("meeting")]),
        calendar("declined", [event("meeting", { responseStatus: "declined" })]),
        calendar("cancelled", [event("meeting", { status: "cancelled" })]),
        calendar("errored", [event("meeting")], { error: "unavailable" }),
    ];
    assert.equal(buildSharedEventGroups(calendars).size, 0);
    calendars.push(calendar("tentative", [event("meeting", { responseStatus: "tentative" })]));
    const groups = buildSharedEventGroups(calendars);
    assert.equal(groups.size, 2);
    assert.deepEqual(entry(groups, "alice", "meeting").calendars.map((item) => item.id), ["alice", "tentative"]);
});

test("duplicate copies in one calendar do not inflate the number of calendars", () => {
    const a = event("a", { uid: "meeting@example.com" });
    const duplicate = event("duplicate", { uid: a.uid });
    const calendars = [calendar("alice", [a, a, duplicate])];
    assert.equal(buildSharedEventGroups(calendars).size, 0);
    calendars.push(calendar("bob", [a], { label: "" }));
    const groups = buildSharedEventGroups(calendars);
    assert.equal(groups.size, 3);
    const group = entry(groups, "alice", a.id);
    assert.equal(group, entry(groups, "alice", duplicate.id));
    assert.equal(group.calendars.length, 2);
    assert.equal(group.calendars[1].label, "bob");
});

test("all-day and transparent invitations can match without mixing timed and all-day occurrences", () => {
    const allDay = event("day", { allDay: true, start: "2026-10-05" });
    const transparent = event("free", { transparency: "transparent" });
    const groups = buildSharedEventGroups([
        calendar("alice", [allDay, transparent]),
        calendar("bob", [allDay, transparent]),
    ]);
    assert.equal(groups.size, 4);
    assert.equal(entry(groups, "alice", "day"), entry(groups, "bob", "day"));
    assert.equal(entry(groups, "alice", "free"), entry(groups, "bob", "free"));
    assert.equal(buildSharedEventGroups([
        calendar("alice", [allDay]),
        calendar("bob", [{ ...allDay, allDay: false, start: "2026-10-05T00:00:00Z" }]),
    ]).size, 0);
});
