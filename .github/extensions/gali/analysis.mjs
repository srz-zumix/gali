// Availability analysis on top of a multi-week fetch.
//
// Four questions, in the order they actually get asked when scheduling:
//   1. When can everyone meet for N minutes?          -> findSlots
//   2. If nobody can, who is the bottleneck?           -> analyzeBlockers
//   3. Are these people already in a room together?    -> findSharedMeetings
//   4. Would moving that meeting even help?            -> simulateReschedule
//
// (3) matters more than it looks: if a recurring meeting already has every
// participant, extending it by 30 minutes costs zero rescheduling. (4) exists
// because the intuitive fix is often worthless — when the blocker is an "away"
// block, moving meetings gains exactly nothing, and it is better to learn that
// in a second than after a round of negotiation.

import { AWAY, MEETING, POLICY, classifyEvent } from "./classify.mjs";
import { clipToDay, isBusyEvent, parseTimeToMinutes } from "./freebusy.mjs";

const DAY_MS = 86_400_000;

export function parseISODate(iso) {
    const [year, month, day] = String(iso).split("-").map(Number);
    return new Date(year, month - 1, day);
}

export function toISODate(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function addDays(iso, amount) {
    const date = parseISODate(iso);
    date.setDate(date.getDate() + amount);
    return toISODate(date);
}

export function formatMinutes(minutes) {
    const hours = Math.floor(minutes / 60);
    return `${String(hours).padStart(2, "0")}:${String(Math.round(minutes) % 60).padStart(2, "0")}`;
}

/** Split [since, until] into <= 7-day chunks; gali fetches one page (MaxResults 1000) with no pagination. */
export function weekChunks(since, until) {
    const chunks = [];
    let cursor = since;
    let guard = 0;
    while (cursor <= until && guard < 60) {
        const end = addDays(cursor, 6);
        chunks.push({ since: cursor, until: end > until ? until : end });
        cursor = addDays(end, 1);
        guard += 1;
    }
    return chunks;
}

export function enumerateDays(since, until, { weekdaysOnly = true } = {}) {
    const days = [];
    let cursor = since;
    let guard = 0;
    while (cursor <= until && guard < 400) {
        const dow = parseISODate(cursor).getDay();
        if (!weekdaysOnly || (dow !== 0 && dow !== 6)) days.push(cursor);
        cursor = addDays(cursor, 1);
        guard += 1;
    }
    return days;
}

// The same invitation can be serialized differently on each attendee's
// calendar (`09:00+09:00` vs `00:00Z`), so the instant — not the raw string —
// identifies an occurrence.
function eventKey(event) {
    const instant = new Date(event.start).getTime();
    return `${event.uid || event.id}\u0000${Number.isNaN(instant) ? String(event.start) : instant}`;
}

/**
 * Flatten every calendar into per-day, classified, minute-based segments.
 * Doing this once keeps the slot loop and the what-if simulation cheap.
 */
export function buildIndex(calendars, days, settings) {
    const workStart = parseTimeToMinutes(settings.workStart, 540);
    const workEnd = parseTimeToMinutes(settings.workEnd, 1080);
    const options = {
        workStart,
        workEnd,
        awayRatio: settings.awayRatio,
        policyPatterns: settings.policyPatterns,
    };

    const byDay = new Map(days.map((day) => [day, []]));
    const meetings = new Map();

    // Pass 1 — merge the same meeting across calendars. Only some attendees may
    // share details, so the title has to be resolved before anything is
    // classified: a policy block looks like an all-day absence when its title
    // is masked.
    for (const calendar of calendars) {
        if (calendar.error) continue;
        for (const event of calendar.events) {
            if (!isBusyEvent(event)) continue;
            const key = eventKey(event);
            if (!meetings.has(key)) {
                meetings.set(key, {
                    key,
                    uid: event.uid || event.id,
                    title: event.detailsVisible ? event.summary : "",
                    detailsVisible: event.detailsVisible,
                    start: event.start,
                    end: event.end,
                    durationMinutes: event.durationMinutes,
                    recurring: event.recurring,
                    attendees: new Set(),
                    kind: MEETING,
                });
            }
            const meeting = meetings.get(key);
            meeting.attendees.add(calendar.id);
            if (event.detailsVisible && !meeting.detailsVisible) {
                meeting.title = event.summary;
                meeting.detailsVisible = true;
            }
        }
    }

    // Pass 2 — classify and lay out, using the merged title.
    for (const calendar of calendars) {
        if (calendar.error) continue;
        for (const event of calendar.events) {
            if (!isBusyEvent(event)) continue;
            const key = eventKey(event);
            const meeting = meetings.get(key);
            for (const day of days) {
                const clipped = clipToDay(event, day);
                if (!clipped) continue;
                const kind = classifyEvent(
                    {
                        ...event,
                        summary: meeting.title || event.summary,
                        startMinutes: clipped[0],
                        endMinutes: clipped[1],
                    },
                    options,
                );
                // Classification is per day, but the label belongs to the whole
                // event: an explicit policy block outranks an away heuristic.
                if (meeting.kind !== POLICY && (kind === POLICY || kind === AWAY)) meeting.kind = kind;
                byDay.get(day).push({
                    start: clipped[0],
                    end: clipped[1],
                    calendarId: calendar.id,
                    label: calendar.label || calendar.id,
                    key,
                    kind,
                });
            }
        }
    }

    return { byDay, meetings, workStart, workEnd };
}

function stepFor(durationMinutes) {
    if (durationMinutes <= 15) return 15;
    return durationMinutes % 30 === 0 ? 30 : 15;
}

/**
 * Walk every candidate start time and record who blocks it.
 * `excludedKeys` powers the what-if simulation without a refetch.
 */
export function scanSlots(index, days, settings, { durationMinutes, holidays, excludedKeys = new Set() } = {}) {
    const { byDay, meetings, workStart, workEnd } = index;
    const step = stepFor(durationMinutes);
    const slots = [];
    // A scan is about future availability: proposing 09:00 today at 16:00 is
    // worse than useless, because ranking puts it first. `includePast` opts a
    // deliberately historical scan back in.
    const now = new Date();
    const cutoffDay = settings.includePast ? null : toISODate(now);
    const cutoffMinutes = now.getHours() * 60 + now.getMinutes();

    for (const day of days) {
        if (cutoffDay && day < cutoffDay) continue;
        const holiday = holidays && holidays.dates.has(day);
        if (holiday && settings.skipHolidays) continue;

        const segments = (byDay.get(day) || []).filter((segment) => !excludedKeys.has(segment.key));

        for (let start = workStart; start + durationMinutes <= workEnd; start += step) {
            if (cutoffDay && day === cutoffDay && start < cutoffMinutes) continue;
            const end = start + durationMinutes;
            const overlapping = segments.filter((segment) => segment.start < end && segment.end > start);

            const policyHit = overlapping.some((segment) => segment.kind === POLICY);
            if (policyHit && settings.skipPolicySlots) continue;

            const blocking = overlapping.filter((segment) => {
                if (segment.kind === POLICY) return false;
                if (segment.kind === AWAY && !settings.treatAwayAsBusy) return false;
                return true;
            });

            const byCalendar = new Map();
            for (const segment of blocking) {
                if (!byCalendar.has(segment.calendarId)) {
                    byCalendar.set(segment.calendarId, { calendarId: segment.calendarId, label: segment.label, keys: new Set() });
                }
                byCalendar.get(segment.calendarId).keys.add(segment.key);
            }

            const distinct = new Set(blocking.map((segment) => segment.key));
            slots.push({
                day,
                start,
                end,
                label: `${day} ${formatMinutes(start)}-${formatMinutes(end)}`,
                free: byCalendar.size === 0,
                holiday: Boolean(holiday),
                policy: policyHit,
                blockers: [...byCalendar.values()].map((entry) => ({
                    calendarId: entry.calendarId,
                    label: entry.label,
                    events: [...entry.keys].map((key) => summarizeMeeting(meetings.get(key))),
                })),
                blockingEvents: [...distinct].map((key) => summarizeMeeting(meetings.get(key))),
            });
        }
    }
    return slots;
}

function summarizeMeeting(meeting) {
    if (!meeting) return null;
    return {
        key: meeting.key,
        uid: meeting.uid,
        title: meeting.detailsVisible ? meeting.title : "（詳細非公開）",
        detailsVisible: meeting.detailsVisible,
        kind: meeting.kind,
        recurring: meeting.recurring,
        durationMinutes: meeting.durationMinutes,
        attendees: [...meeting.attendees],
    };
}

/** Contiguous free runs, so a 30-minute ask can see it actually has 90 minutes. */
function mergeRuns(freeSlots, durationMinutes) {
    const runs = [];
    for (const slot of freeSlots) {
        const last = runs[runs.length - 1];
        if (last && last.day === slot.day && slot.start <= last.end) {
            last.end = Math.max(last.end, slot.end);
            continue;
        }
        runs.push({ day: slot.day, start: slot.start, end: slot.end });
    }
    return runs.filter((run) => run.end - run.start >= durationMinutes);
}

/**
 * Rank the openings. Sooner is better, a longer surrounding run is better, and
 * sitting next to a meeting every participant already attends is best of all —
 * that one needs no rescheduling, just a longer booking.
 */
export function findSlots(index, days, settings, { durationMinutes, holidays }) {
    const slots = scanSlots(index, days, settings, { durationMinutes, holidays });
    const free = slots.filter((slot) => slot.free);
    const runs = mergeRuns(free, durationMinutes);
    const participants = settings.participantCount || 0;

    const adjacency = new Map();
    for (const meeting of index.meetings.values()) {
        if (participants && meeting.attendees.size < participants) continue;
        if (meeting.kind !== MEETING) continue;
        const startDay = String(meeting.start).slice(0, 10);
        const startMin = minutesOfDay(meeting.start);
        const endMin = minutesOfDay(meeting.end);
        adjacency.set(`${startDay}\u0000${endMin}`, meeting);
        adjacency.set(`${startDay}\u0000before:${startMin}`, meeting);
    }

    const candidates = runs.map((run) => {
        const daysOut = Math.max(0, Math.round((parseISODate(run.day) - startOfToday()) / DAY_MS));
        const length = run.end - run.start;
        const after = adjacency.get(`${run.day}\u0000${run.start}`);
        const before = adjacency.get(`${run.day}\u0000before:${run.end}`);
        const neighbour = after || before;
        // "Extend the meeting that precedes/follows this run" only holds if the
        // booking actually touches it, so a before-only match sits at the end.
        const slotStart = after ? run.start : before ? run.end - durationMinutes : run.start;

        let score = 100 - daysOut * 2 + Math.min(30, (length - durationMinutes) / 5);
        const reasons = [];
        if (neighbour) {
            score += 40;
            reasons.push(
                `全員が参加する「${neighbour.detailsVisible ? neighbour.title : "（詳細非公開）"}」の${after ? "直後" : "直前"}なので、その予定を延長すれば調整不要`,
            );
        }
        if (length >= durationMinutes * 2) reasons.push(`前後に余裕があります（${length}分の連続空き）`);
        if (daysOut <= 3) reasons.push("直近で確保できます");

        return {
            day: run.day,
            start: formatMinutes(slotStart),
            end: formatMinutes(slotStart + durationMinutes),
            blockEnd: formatMinutes(run.end),
            blockMinutes: length,
            score: Math.round(score),
            reasons,
            adjacentMeeting: neighbour ? summarizeMeeting(neighbour) : null,
        };
    });

    candidates.sort((a, b) => b.score - a.score || a.day.localeCompare(b.day) || a.start.localeCompare(b.start));
    return { candidates, totalFreeSlots: free.length, scannedSlots: slots.length, slots };
}

function minutesOfDay(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return -1;
    return date.getHours() * 60 + date.getMinutes();
}

function startOfToday() {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

/**
 * Who is costing us the most, and which slots are one person away from working.
 * `soleBlocker` is the number the user actually cares about.
 */
export function analyzeBlockers(slots, calendars) {
    const stats = new Map(
        calendars
            .filter((calendar) => !calendar.error)
            .map((calendar) => [
                calendar.id,
                {
                    calendarId: calendar.id,
                    label: calendar.label || calendar.id,
                    slotsBlocked: 0,
                    soleBlocker: 0,
                    awaySlots: 0,
                    meetingSlots: 0,
                },
            ]),
    );

    const nearMiss = [];
    for (const slot of slots) {
        if (slot.free) continue;
        for (const blocker of slot.blockers) {
            const entry = stats.get(blocker.calendarId);
            if (!entry) continue;
            entry.slotsBlocked += 1;
            if (slot.blockers.length === 1) entry.soleBlocker += 1;
            if (blocker.events.some((event) => event && event.kind === AWAY)) entry.awaySlots += 1;
            else entry.meetingSlots += 1;
        }
        if (slot.blockers.length === 1) {
            nearMiss.push({
                day: slot.day,
                start: formatMinutes(slot.start),
                end: formatMinutes(slot.end),
                blocker: slot.blockers[0].label,
                events: slot.blockers[0].events,
                // An away block cannot be negotiated away by moving a meeting.
                movable: slot.blockers[0].events.every((event) => event && event.kind === MEETING),
            });
        }
    }

    return {
        blockers: [...stats.values()].sort((a, b) => b.soleBlocker - a.soleBlocker || b.slotsBlocked - a.slotsBlocked),
        nearMiss,
    };
}

/** Meetings that more than one of the watched calendars attends, grouped by title. */
/**
 * Google gives every instance of a recurring series a UID of
 * `<series>_R<timestamp>@google.com`; strip the suffix to recover the series.
 */
function seriesId(uid) {
    return String(uid || "").replace(/_R\d{8}T\d{6}(?=@|$)/, "");
}

export function findSharedMeetings(index, { minAttendees = 2 } = {}) {
    const groups = new Map();
    for (const meeting of index.meetings.values()) {
        if (meeting.attendees.size < minAttendees) continue;
        // Away/policy blocks are shared too, but they are not reschedulable:
        // offering them to simulate_reschedule would report an absence that
        // "frees up" a whole day.
        if (meeting.kind !== MEETING) continue;
        const attendees = [...meeting.attendees].sort();
        // Group by series, not by title: two different private meetings both
        // render as "（詳細非公開）" and must not collapse into one row.
        const groupKey = `${seriesId(meeting.uid)}\u0000${attendees.join(",")}`;
        if (!groups.has(groupKey)) {
            groups.set(groupKey, {
                title: meeting.detailsVisible ? meeting.title : "（詳細非公開）",
                detailsVisible: meeting.detailsVisible,
                attendees,
                attendeeCount: attendees.length,
                recurring: meeting.recurring,
                kind: meeting.kind,
                occurrences: [],
                keys: [],
            });
        }
        const group = groups.get(groupKey);
        group.recurring = group.recurring || meeting.recurring;
        if (meeting.detailsVisible && !group.detailsVisible) {
            group.title = meeting.title;
            group.detailsVisible = true;
        }
        group.occurrences.push({ start: meeting.start, end: meeting.end, durationMinutes: meeting.durationMinutes });
        group.keys.push(meeting.key);
    }
    return [...groups.values()]
        .map((group) => ({ ...group, occurrences: group.occurrences.sort((a, b) => a.start.localeCompare(b.start)) }))
        .sort((a, b) => b.attendeeCount - a.attendeeCount || b.occurrences.length - a.occurrences.length);
}

/** What-if: drop a meeting group and count the slots that open up. */
export function simulateReschedule(index, days, settings, { keys, durationMinutes, holidays }) {
    const baseline = scanSlots(index, days, settings, { durationMinutes, holidays })
        .filter((slot) => slot.free)
        .map((slot) => slot.label);
    const baselineSet = new Set(baseline);

    const after = scanSlots(index, days, settings, {
        durationMinutes,
        holidays,
        excludedKeys: new Set(keys),
    }).filter((slot) => slot.free);

    const gained = after.filter((slot) => !baselineSet.has(slot.label));
    return {
        baselineCount: baseline.length,
        afterCount: after.length,
        delta: gained.length,
        gainedSlots: gained.map((slot) => ({ day: slot.day, start: formatMinutes(slot.start), end: formatMinutes(slot.end) })),
    };
}
