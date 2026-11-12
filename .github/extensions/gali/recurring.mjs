import { addDays, enumerateDays, formatMinutes, parseISODate, scanSlots, toISODate } from "./analysis.mjs";

export const RECURRENCES = ["weekly", "biweekly", "monthly-date", "monthly-weekday", "monthly-last"];

function recurrencePattern(day, recurrence) {
    const date = parseISODate(day);
    const weekday = date.getDay();
    if (recurrence === "weekly") return { weekday };
    if (recurrence === "biweekly") {
        const [year, month, dayOfMonth] = day.split("-").map(Number);
        const ordinal = Math.floor((Date.UTC(year, month - 1, dayOfMonth) - Date.UTC(1970, 0, 5)) / 86_400_000);
        return { weekday, phase: ((Math.floor(ordinal / 7) % 2) + 2) % 2 };
    }
    if (recurrence === "monthly-date") return { monthDay: date.getDate() };
    if (recurrence === "monthly-weekday") return { weekday, ordinal: Math.ceil(date.getDate() / 7) };
    if (addDays(day, 7).slice(0, 7) !== day.slice(0, 7)) return { weekday };
    return null;
}

// Wall-clock times in a DST gap or fold cannot be promised without choosing
// a specific offset. Cross-transition durations are also left unchecked.
function uncertainLocalTime(day, start, durationMinutes) {
    const [year, month, date] = day.split("-").map(Number);
    const local = (minutes) => new Date(year, month - 1, date, Math.floor(minutes / 60), minutes % 60);
    const from = local(start);
    const until = local(start + durationMinutes);
    if ((until - from) / 60_000 !== durationMinutes) return true;
    if (from.getHours() * 60 + from.getMinutes() !== start) return true;
    if (until.getHours() * 60 + until.getMinutes() !== (start + durationMinutes) % 1440) return true;
    const dayStart = new Date(year, month - 1, date);
    const nextDay = new Date(year, month - 1, date + 1);
    const offsetChange = nextDay.getTimezoneOffset() - dayStart.getTimezoneOffset();
    if (offsetChange <= 0) return false;
    const sameWallTime = (left, right) =>
        left.getFullYear() === right.getFullYear() && left.getMonth() === right.getMonth()
        && left.getDate() === right.getDate() && left.getHours() === right.getHours()
        && left.getMinutes() === right.getMinutes();
    return [from, until].some((value) =>
        sameWallTime(value, new Date(value.getTime() + offsetChange * 60_000))
        || sameWallTime(value, new Date(value.getTime() - offsetChange * 60_000)));
}

/**
 * Evaluate complete local-time recurrence patterns within the fetched range.
 * Every expected occurrence is either free, busy, or explicitly unchecked.
 */
export function findRecurringSlots(index, days, settings, {
    from, until, recurrence, durationMinutes, holidays, excludedKeys = new Set(), now = new Date(),
} = {}) {
    if (!RECURRENCES.includes(recurrence)) throw new Error("繰り返し周期を選択してください。");
    if (!Number.isInteger(durationMinutes) || durationMinutes < 15 || durationMinutes > 480) {
        throw new Error("会議の長さは15〜480分で指定してください。");
    }

    const allDays = enumerateDays(from, until, { weekdaysOnly: false });
    const patterns = new Map();
    for (const day of allDays) {
        const pattern = recurrencePattern(day, recurrence);
        if (!pattern) continue;
        const key = JSON.stringify(pattern);
        if (!patterns.has(key)) patterns.set(key, { pattern, days: [] });
        patterns.get(key).days.push(day);
    }

    const daySet = new Set(days);
    const slots = scanSlots(index, days, { ...settings, skipHolidays: false, skipPolicySlots: false }, {
        durationMinutes, holidays, excludedKeys, now,
    });
    const slotMap = new Map(slots.map((slot) => [`${slot.day}\u0000${slot.start}`, slot]));
    const cutoffDay = settings.includePast ? null : toISODate(now);
    const cutoffMinutes = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60 + now.getMilliseconds() / 60_000;
    const step = durationMinutes <= 15 || durationMinutes % 30 !== 0 ? 15 : 30;
    const candidates = [];
    for (const { pattern, days: patternDays } of patterns.values()) {
        for (let start = index.workStart; start + durationMinutes <= index.workEnd; start += step) {
            const occurrences = [];
            for (const day of patternDays) {
                if (cutoffDay && (day < cutoffDay || (day === cutoffDay && start < cutoffMinutes))) continue;
                let occurrence;
                if (!daySet.has(day)) occurrence = { day, status: "excluded", reason: "weekday" };
                else if (settings.skipHolidays && holidays?.dates.has(day)) occurrence = { day, status: "excluded", reason: "holiday" };
                else if (uncertainLocalTime(day, start, durationMinutes)) occurrence = { day, status: "excluded", reason: "timezone" };
                else {
                    const slot = slotMap.get(`${day}\u0000${start}`);
                    if (!slot) throw new Error(`予定を判定できませんでした: ${day} ${formatMinutes(start)}`);
                    if (settings.skipPolicySlots && slot.policy) occurrence = { day, status: "excluded", reason: "policy" };
                    else if (!slot.free) {
                        occurrence = { day, status: "busy", blockers: slot.blockers.map((blocker) => blocker.label) };
                    } else occurrence = { day, status: "free" };
                }
                occurrences.push(occurrence);
            }
            if (!occurrences.length) continue;
            const freeCount = occurrences.filter((item) => item.status === "free").length;
            const busyCount = occurrences.filter((item) => item.status === "busy").length;
            const excludedCount = occurrences.length - freeCount - busyCount;
            candidates.push({
                pattern: { ...pattern, anchor: occurrences[0].day },
                start: formatMinutes(start),
                end: formatMinutes(start + durationMinutes),
                expectedCount: occurrences.length,
                freeCount,
                busyCount,
                excludedCount,
                occurrences,
            });
        }
    }
    candidates.sort((a, b) =>
        b.freeCount / b.expectedCount - a.freeCount / a.expectedCount
        || (b.freeCount + b.busyCount) - (a.freeCount + a.busyCount)
        || a.busyCount - b.busyCount
        || a.pattern.anchor.localeCompare(b.pattern.anchor)
        || a.start.localeCompare(b.start));
    return { from, until, recurrence, durationMinutes, candidates };
}
