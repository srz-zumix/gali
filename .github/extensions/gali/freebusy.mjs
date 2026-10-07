// Common free/busy math shared by the snapshot builder.
//
// Only timed events count as busy: all-day markers and events the owner marked
// as "free" (transparency: transparent) do not block a slot. Declined events
// never block availability, even when displayed in the calendar.

const MIN_SLOT_MINUTES = 30;

export function parseTimeToMinutes(value, fallback) {
    const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || ""));
    return match ? Number(match[1]) * 60 + Number(match[2]) : fallback;
}

export function dayBounds(iso) {
    const [year, month, day] = String(iso).split("-").map(Number);
    return [new Date(year, month - 1, day), new Date(year, month - 1, day + 1)];
}

/**
 * Wall-clock minutes since the start of `iso`, clamped to that calendar day.
 *
 * Elapsed milliseconds cannot be used: on a DST transition the day is 23 or 25
 * hours long, so 09:00 would not land on the 09:00 grid line. During a repeated
 * hour both occurrences map to the same wall-clock minute, which is what the
 * grid shows anyway.
 */
export function wallMinutes(date, dayStart, dayEnd) {
    if (date <= dayStart) return 0;
    if (date >= dayEnd) return 1440;
    return date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60;
}

export function clipToDay(event, iso) {
    const [dayStart, dayEnd] = dayBounds(iso);
    const start = new Date(event.start);
    const end = event.end ? new Date(event.end) : new Date(start.getTime() + 30 * 60_000);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
    if (end <= dayStart || start >= dayEnd) return null;
    const from = wallMinutes(start, dayStart, dayEnd);
    const to = wallMinutes(end, dayStart, dayEnd);
    if (to <= from) return null;
    return [from, to];
}

function mergeIntervals(intervals) {
    const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const [start, end] of sorted) {
        const last = merged[merged.length - 1];
        if (last && start <= last[1]) last[1] = Math.max(last[1], end);
        else merged.push([start, end]);
    }
    return merged;
}

export function isBusyEvent(event) {
    return !event.allDay && event.transparency !== "transparent" && event.responseStatus !== "declined";
}

export function busyIntervals(calendars, iso) {
    return mergeIntervals(busySegments(calendars, iso).map((segment) => [segment.start, segment.end]));
}

/**
 * The same busy math as `busyIntervals`, but keeping the attribution.
 *
 * Merging every calendar into one set of intervals answers "is this slot free?"
 * and nothing else. Knowing *who* is blocking, and with *which* event, is what
 * lets the canvas say "one person is out all week" instead of "no availability".
 */
export function busySegments(calendars, iso) {
    const segments = [];
    for (const calendar of calendars) {
        if (calendar.error) continue;
        for (const event of calendar.events) {
            if (!isBusyEvent(event)) continue;
            const clipped = clipToDay(event, iso);
            if (!clipped) continue;
            segments.push({
                start: clipped[0],
                end: clipped[1],
                calendarId: calendar.id,
                label: calendar.label || calendar.id,
                event,
            });
        }
    }
    return segments.sort((a, b) => a.start - b.start);
}

/** Slots inside the configured working hours where every calendar is free. */
export function computeFreeSlots(snapshot, settings) {
    if (!snapshot) return [];
    const workStart = parseTimeToMinutes(settings.workStart, 540);
    const workEnd = parseTimeToMinutes(settings.workEnd, 1080);
    if (workEnd <= workStart) return [];
    // A calendar we failed to read is not a calendar with no events: showing
    // the rest as "everyone is free" would invent availability.
    if (snapshot.calendars.some((calendar) => calendar.error)) return [];
    const usable = snapshot.calendars;
    if (!usable.length) return [];

    return snapshot.range.days.map((day) => {
        const slots = [];
        let cursor = workStart;
        for (const [start, end] of busyIntervals(usable, day)) {
            if (end <= workStart || start >= workEnd) continue;
            if (start > cursor) slots.push([cursor, Math.min(start, workEnd)]);
            cursor = Math.max(cursor, end);
            if (cursor >= workEnd) break;
        }
        if (cursor < workEnd) slots.push([cursor, workEnd]);
        return {
            day,
            slots: slots.filter(([start, end]) => end - start >= MIN_SLOT_MINUTES),
        };
    });
}

export function formatMinutes(minutes) {
    const hours = Math.floor(minutes / 60) % 24;
    return `${String(hours).padStart(2, "0")}:${String(Math.round(minutes) % 60).padStart(2, "0")}`;
}
