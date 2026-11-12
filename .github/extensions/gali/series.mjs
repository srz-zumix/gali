import { MEETING } from "./classify.mjs";

/**
 * Link series only through an exact iCalUID or a calendar-scoped recurring
 * event ID. Attendee lists can differ between occurrences, so they are not an
 * identity.
 */
export function findRecurringSeries(index) {
    const aliases = new Map();
    const groups = new Set();
    for (const meeting of index.meetings.values()) {
        if (!meeting.recurring) continue;
        const identities = [...(meeting.seriesAliases || [])];
        const matches = new Set(identities.map((identity) => aliases.get(identity)).filter(Boolean));
        const group = matches.values().next().value || {
            aliases: new Set(), meetings: new Set(),
        };
        for (const other of matches) {
            if (other === group) continue;
            for (const identity of other.aliases) {
                group.aliases.add(identity);
                aliases.set(identity, group);
            }
            for (const item of other.meetings) group.meetings.add(item);
            groups.delete(other);
        }
        for (const identity of identities) {
            group.aliases.add(identity);
            aliases.set(identity, group);
        }
        group.meetings.add(meeting);
        groups.add(group);
    }

    return [...groups].map((group) => {
        const meetings = [...group.meetings].sort((a, b) => a.start.localeCompare(b.start) || a.key.localeCompare(b.key));
        const movable = meetings.filter((meeting) => meeting.kind === MEETING);
        const visible = meetings.find((meeting) => meeting.detailsVisible);
        const calendarSeries = new Map();
        for (const identity of group.aliases) {
            const [type, calendar, recurringId] = JSON.parse(identity);
            if (type !== "calendar") continue;
            if (!calendarSeries.has(calendar)) calendarSeries.set(calendar, new Set());
            calendarSeries.get(calendar).add(recurringId);
        }
        const ambiguous = meetings.some((meeting) =>
            meeting.missingIdentity || (meeting.weakIdentity && meeting.attendees.size > 1))
            || [...calendarSeries.values()].some((ids) => ids.size > 1);
        return {
            title: visible ? visible.title : "（詳細非公開）",
            detailsVisible: Boolean(visible),
            attendees: [...new Set(meetings.flatMap((meeting) => [...meeting.attendees]))].sort(),
            occurrences: meetings.length,
            firstStart: meetings[0]?.start || "",
            durations: [...new Set(movable.map((meeting) => meeting.durationMinutes).filter(Number.isFinite))].sort((a, b) => a - b),
            movableKeys: movable.map((meeting) => meeting.key),
            retainedOccurrences: meetings.length - movable.length,
            identified: group.aliases.size > 0 && !ambiguous,
        };
    }).filter((group) => group.movableKeys.length)
        .sort((a, b) => a.firstStart.localeCompare(b.firstStart) || a.title.localeCompare(b.title));
}
