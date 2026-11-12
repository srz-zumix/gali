import assert from "node:assert/strict";
import { test } from "node:test";

import { buildIndex, enumerateDays, findSharedMeetings, simulateReschedule } from "./analysis.mjs";
import { findRecurringSlots } from "./recurring.mjs";
import { findRecurringSeries } from "./series.mjs";
import { DEFAULT_SETTINGS } from "./store.mjs";

function event(day, id, start = "10:00", end = "10:30", extra = {}) {
    return {
        id,
        uid: id,
        summary: id,
        detailsVisible: true,
        start: `${day}T${start}:00`,
        end: `${day}T${end}:00`,
        durationMinutes: 30,
        allDay: false,
        ...extra,
    };
}

function evaluate({ from, until, recurrence = "weekly", calendars = [{ id: "alice", events: [] }],
    settings = {}, holidays = new Set(), durationMinutes = 30, excludedKeys, now } = {}) {
    const options = { ...DEFAULT_SETTINGS, workStart: "10:00", workEnd: "11:00", includePast: true, ...settings };
    const days = enumerateDays(from, until, { weekdaysOnly: options.scanWeekdaysOnly });
    const index = buildIndex(calendars, days, options);
    const result = findRecurringSlots(index, days, options, {
        from, until, recurrence, durationMinutes, holidays: { dates: holidays }, excludedKeys, now,
    });
    return { index, days, options, result };
}

function candidate(result, predicate, start = "10:00") {
    const found = result.candidates.find((entry) => entry.start === start && predicate(entry.pattern));
    assert.ok(found, `missing ${start} candidate`);
    return found;
}

test("weekly candidates account for free, busy, holidays and policy exclusions", () => {
    const { result } = evaluate({
        from: "2026-01-05", until: "2026-01-26",
        calendars: [{ id: "alice", label: "Alice", events: [
            event("2026-01-12", "busy"),
            event("2026-01-26", "policy", "10:00", "10:30", { summary: "NoMTG" }),
        ] }],
        holidays: new Set(["2026-01-19"]),
    });
    const monday = candidate(result, (pattern) => pattern.weekday === 1);
    assert.equal(monday.expectedCount, 4);
    assert.equal(monday.freeCount, 1);
    assert.equal(monday.busyCount, 1);
    assert.equal(monday.excludedCount, 2);
    assert.deepEqual(monday.occurrences, [
        { day: "2026-01-05", status: "free" },
        { day: "2026-01-12", status: "busy", blockers: ["Alice"] },
        { day: "2026-01-19", status: "excluded", reason: "holiday" },
        { day: "2026-01-26", status: "excluded", reason: "policy" },
    ]);
    const saturday = candidate(result, (pattern) => pattern.weekday === 6);
    assert.equal(saturday.freeCount, 0);
    assert.equal(saturday.busyCount, 0);
    assert.equal(saturday.excludedCount, saturday.expectedCount);
});

test("biweekly phases remain distinct even when the first occurrence is a holiday", () => {
    const { result } = evaluate({
        from: "2026-01-05", until: "2026-02-01", recurrence: "biweekly",
        holidays: new Set(["2026-01-05"]),
    });
    const mondays = result.candidates.filter((entry) => entry.start === "10:00" && entry.pattern.weekday === 1)
        .sort((a, b) => a.pattern.anchor.localeCompare(b.pattern.anchor));
    assert.equal(mondays.length, 2);
    assert.deepEqual(mondays.map((entry) => entry.occurrences.map((item) => item.day)), [
        ["2026-01-05", "2026-01-19"],
        ["2026-01-12", "2026-01-26"],
    ]);
    assert.equal(mondays[0].occurrences[0].reason, "holiday");

    const shifted = evaluate({ from: "2026-01-12", until: "2026-02-01", recurrence: "biweekly" }).result;
    const samePhase = candidate(shifted, (pattern) => pattern.weekday === 1 && pattern.phase === mondays[0].pattern.phase);
    assert.deepEqual(samePhase.occurrences.map((item) => item.day), ["2026-01-19"]);
});

test("monthly patterns do not shift missing dates or missing ordinal weekdays", () => {
    const common = { from: "2026-01-01", until: "2026-06-30", settings: { scanWeekdaysOnly: false } };
    const byDate = evaluate({ ...common, recurrence: "monthly-date" }).result;
    const thirtyFirst = candidate(byDate, (pattern) => pattern.monthDay === 31);
    assert.deepEqual(thirtyFirst.occurrences.map((item) => item.day), [
        "2026-01-31", "2026-03-31", "2026-05-31",
    ]);
    const byWeekday = evaluate({ ...common, recurrence: "monthly-weekday" }).result;
    const fifthMonday = candidate(byWeekday, (pattern) => pattern.weekday === 1 && pattern.ordinal === 5);
    assert.deepEqual(fifthMonday.occurrences.map((item) => item.day), ["2026-03-30", "2026-06-29"]);
    const lastMonday = candidate(evaluate({ ...common, recurrence: "monthly-last" }).result, (pattern) => pattern.weekday === 1);
    assert.deepEqual(lastMonday.occurrences.map((item) => item.day), [
        "2026-01-26", "2026-02-23", "2026-03-30", "2026-04-27", "2026-05-25", "2026-06-29",
    ]);
});

test("past starts are not included in future recurring candidates", () => {
    const { result } = evaluate({
        from: "2026-01-05", until: "2026-01-19",
        settings: { includePast: false },
        now: new Date(2026, 0, 5, 10, 0, 1),
    });
    const monday = candidate(result, (pattern) => pattern.weekday === 1);
    assert.equal(monday.pattern.anchor, "2026-01-12");
    assert.deepEqual(monday.occurrences.map((item) => item.day), ["2026-01-12", "2026-01-19"]);
});

test("series use reliable identities across attendee changes without merging unrelated events", () => {
    const from = "2026-01-05";
    const until = "2026-01-19";
    const seriesEvent = (day, id, series, extra = {}) => event(day, id, "10:00", "10:30", {
        uid: "shared@example.test", recurring: true, recurringEventId: series, ...extra,
    });
    const calendars = [
        { id: "alice", events: [
            seriesEvent("2026-01-05", "a1", "alice-series"),
            seriesEvent("2026-01-12", "a2", "alice-series"),
            event("2026-01-19", "unrelated", "10:00", "10:30", {
                uid: "other@example.test", recurring: true, recurringEventId: "other-series",
            }),
        ] },
        { id: "bob", events: [seriesEvent("2026-01-05", "b1", "bob-series")] },
    ];
    const { index, days, options } = evaluate({ from, until, calendars });
    const series = findRecurringSeries(index);
    assert.equal(series.length, 2);
    const shared = series.find((entry) => entry.occurrences === 2);
    assert.deepEqual(shared.attendees, ["alice", "bob"]);
    assert.equal(shared.identified, true);
    assert.equal(shared.movableKeys.length, 2);
    const result = findRecurringSlots(index, days, options, {
        from, until, recurrence: "weekly", durationMinutes: 30,
        holidays: { dates: new Set() }, excludedKeys: new Set(shared.movableKeys),
    });
    const monday = candidate(result, (pattern) => pattern.weekday === 1);
    assert.deepEqual(monday.occurrences.map((item) => item.status), ["free", "free", "busy"]);
});

test("ambiguous fallback IDs and conflicting series identifiers cannot be used for relocation", () => {
    const sameId = (id, series) => event("2026-01-05", id, "10:00", "10:30", {
        recurring: true, recurringEventId: series,
    });
    const ambiguous = evaluate({
        from: "2026-01-05", until: "2026-01-12",
        calendars: [
            { id: "alice", events: [sameId("local-id", "series-a")] },
            { id: "bob", events: [sameId("local-id", "series-b")] },
        ],
    });
    assert.equal(findRecurringSeries(ambiguous.index)[0].identified, false);

    const conflicting = evaluate({
        from: "2026-01-05", until: "2026-01-12",
        calendars: [{ id: "alice", events: [
            event("2026-01-05", "a1", "10:00", "10:30", {
                uid: "same@example.test", recurring: true, recurringEventId: "series-a",
            }),
            event("2026-01-12", "a2", "10:00", "10:30", {
                uid: "same@example.test", recurring: true, recurringEventId: "series-b",
            }),
        ] }],
    });
    assert.equal(findRecurringSeries(conflicting.index)[0].identified, false);
});

test("UID prefixes never merge unrelated series or exclude their occurrences", () => {
    const firstUid = "root_R20260105T100000@google.com";
    const secondUid = "root_R20260112T100000@google.com";
    const recurring = (day, id, uid, series) => event(day, id, "10:00", "10:30", {
        uid, recurring: true, recurringEventId: series,
    });
    const { index, days, options } = evaluate({
        from: "2026-01-05", until: "2026-01-12",
        calendars: [
            { id: "alice", events: [recurring("2026-01-05", "a", firstUid, "a-series")] },
            { id: "bob", events: [recurring("2026-01-12", "b", secondUid, "b-series")] },
        ],
    });
    const series = findRecurringSeries(index);
    assert.equal(series.length, 2);
    const first = series.find((item) => item.firstStart.startsWith("2026-01-05"));
    const result = findRecurringSlots(index, days, options, {
        from: "2026-01-05", until: "2026-01-12", recurrence: "weekly", durationMinutes: 30,
        holidays: { dates: new Set() }, excludedKeys: new Set(first.movableKeys),
    });
    const monday = candidate(result, (pattern) => pattern.weekday === 1);
    assert.deepEqual(monday.occurrences.map((item) => item.status), ["free", "busy"]);
});

test("calendar-scoped IDs join different occurrence UIDs and shared what-if keeps separate series", () => {
    const firstUid = "root_R20260105T100000@google.com";
    const secondUid = "root_R20260112T100000@google.com";
    const recurring = (day, id, uid, series) => event(day, id, "10:00", "10:30", {
        uid, recurring: true, recurringEventId: series,
    });
    const joined = evaluate({
        from: "2026-01-05", until: "2026-01-12",
        calendars: [
            { id: "alice", events: [
                recurring("2026-01-05", "a1", firstUid, "alice-series"),
                recurring("2026-01-12", "a2", secondUid, "alice-series"),
            ] },
            { id: "bob", events: [recurring("2026-01-12", "b2", secondUid, "bob-series")] },
        ],
    });
    assert.equal(findRecurringSeries(joined.index).length, 1);
    assert.equal(findRecurringSeries(joined.index)[0].movableKeys.length, 2);

    const split = evaluate({
        from: "2026-01-05", until: "2026-01-12",
        calendars: [
            { id: "alice", events: [
                recurring("2026-01-05", "a1", firstUid, "alice-first"),
                recurring("2026-01-12", "a2", secondUid, "alice-second"),
            ] },
            { id: "bob", events: [
                recurring("2026-01-05", "b1", firstUid, "bob-first"),
                recurring("2026-01-12", "b2", secondUid, "bob-second"),
            ] },
        ],
    });
    const shared = findSharedMeetings(split.index);
    assert.equal(shared.length, 2);
    const first = shared.find((item) => item.occurrences[0].start.startsWith("2026-01-05"));
    const whatIf = simulateReschedule(split.index, split.days, split.options, {
        keys: first.keys, durationMinutes: 30, holidays: { dates: new Set() },
    });
    assert.deepEqual(whatIf.gainedSlots, [{ day: "2026-01-05", start: "10:00", end: "10:30" }]);
});

test("candidates remain visible even if every occurrence conflicts", () => {
    const { result } = evaluate({
        from: "2026-01-05", until: "2026-01-12",
        calendars: [{ id: "alice", events: [
            event("2026-01-05", "one"),
            event("2026-01-12", "two"),
        ] }],
    });
    const monday = candidate(result, (pattern) => pattern.weekday === 1);
    assert.equal(monday.freeCount, 0);
    assert.equal(monday.busyCount, 2);
    assert.deepEqual(monday.occurrences.map((item) => item.day), ["2026-01-05", "2026-01-12"]);
});

test("local daylight-saving gaps and folds are never counted as verified free", (t) => {
    const previous = process.env.TZ;
    process.env.TZ = "America/New_York";
    t.after(() => {
        if (previous === undefined) delete process.env.TZ;
        else process.env.TZ = previous;
    });
    for (const [day, uncertain] of [["2026-03-08", "02:00"], ["2026-11-01", "01:00"]]) {
        const { result } = evaluate({
            from: day, until: day, settings: { scanWeekdaysOnly: false, workStart: "01:00", workEnd: "04:00" },
        });
        const weekday = parseInt(day.slice(-2), 10);
        const selected = result.candidates.find((entry) => entry.start === uncertain);
        assert.ok(selected, `missing DST candidate on day ${weekday}`);
        assert.deepEqual(selected.occurrences, [{ day, status: "excluded", reason: "timezone" }]);
        const ordinary = result.candidates.find((entry) => entry.start === "03:00");
        assert.equal(ordinary.freeCount, 1);
    }
});
