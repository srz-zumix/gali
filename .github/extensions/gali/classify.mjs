// Not every "busy" block means the same thing.
//
// The motivating case: a colleague had a private 09:00-18:00 event on every
// weekday of a two-week stretch. Treated as an ordinary meeting it makes them
// look merely busy, and the obvious conclusion ("reschedule something") is
// wrong — they are away, and no amount of moving meetings will help. Splitting
// blocks into meeting / away / policy keeps that distinction visible.

export const AWAY = "away";
export const POLICY = "policy";
export const MEETING = "meeting";

export const DEFAULT_POLICY_PATTERNS = ["NoMTG", "No MTG", "ノーMTG", "ノーミーティング", "No Meeting"];

/** A block counts as "away" once it covers this share of the working window. */
export const DEFAULT_AWAY_RATIO = 0.8;

function matchesPolicy(summary, patterns) {
    if (!summary) return false;
    const haystack = summary.toLowerCase();
    return patterns.some((pattern) => pattern && haystack.includes(String(pattern).toLowerCase()));
}

/**
 * Classify one timed event against the working window.
 *
 * `workStart` / `workEnd` are minutes from midnight; `span` is the event's
 * overlap with the working window on the day being classified, so a 09:00-18:00
 * event and a 00:00-23:59 event both come out as `away`.
 */
export function classifyEvent(event, { workStart, workEnd, awayRatio, policyPatterns }) {
    if (matchesPolicy(event.summary, policyPatterns)) return POLICY;

    const window = Math.max(1, workEnd - workStart);
    const start = Math.max(event.startMinutes, workStart);
    const end = Math.min(event.endMinutes, workEnd);
    const covered = Math.max(0, end - start);
    if (covered / window >= awayRatio) return AWAY;

    // A block that runs across the whole day but is clipped by the working
    // window (e.g. 14:00-24:00) still reads as "away" for the part it covers,
    // but only if it is genuinely long rather than a normal long meeting.
    if (event.durationMinutes >= window && covered > 0) return AWAY;

    return MEETING;
}

export function classificationLabel(kind) {
    if (kind === AWAY) return "終日ブロック（不在の可能性）";
    if (kind === POLICY) return "ポリシー枠";
    return "会議";
}

/**
 * All-day events on a holiday calendar become a set of dates to skip.
 * Recommended calendar for Japan: en.japanese#holiday@group.v.calendar.google.com
 */
export function holidayDatesFrom(events) {
    const dates = new Set();
    const labels = new Map();
    for (const event of events || []) {
        if (!event.allDay || !event.start) continue;
        // Google's all-day `end` is exclusive.
        let cursor = event.start;
        const limit = event.end || event.start;
        let guard = 0;
        while (cursor < limit && guard < 400) {
            dates.add(cursor);
            if (event.summary) labels.set(cursor, event.summary);
            cursor = nextDay(cursor);
            guard += 1;
        }
        if (!dates.has(event.start)) {
            dates.add(event.start);
            if (event.summary) labels.set(event.start, event.summary);
        }
    }
    return { dates, labels };
}

function nextDay(iso) {
    const [year, month, day] = iso.split("-").map(Number);
    const date = new Date(year, month - 1, day + 1);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
