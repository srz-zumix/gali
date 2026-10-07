// Match invitations by occurrence, not by title or coincident busy time.
export function eventKey(event, identity = event.uid || event.id) {
    const instant = new Date(event.start).getTime();
    return `${identity}\u0000${Number.isNaN(instant) ? String(event.start) : instant}`;
}

export const calendarEventKey = (calendarId, eventId) => `${calendarId}\u0000${eventId}`;

export function buildSharedEventGroups(calendars) {
    const aliases = new Map();
    const groups = new Set();

    for (const calendar of calendars) {
        if (calendar.error) continue;
        for (const event of calendar.events) {
            if (!event.id || !event.start || Number.isNaN(new Date(event.start).getTime())) continue;
            if (event.status === "cancelled" || event.responseStatus === "declined") continue;

            const kind = event.allDay ? "day" : "time";
            const keys = [`${kind}:id:${eventKey(event, event.id)}`];
            // Normalization falls back to the event ID when iCalUID is absent.
            if (event.uid && event.uid !== event.id) keys.push(`${kind}:uid:${eventKey(event)}`);
            const matches = new Set(keys.map((key) => aliases.get(key)).filter(Boolean));
            const group = matches.values().next().value || {
                aliases: new Set(),
                eventKeys: new Set(),
                calendars: new Map(),
                start: new Date(event.start).getTime(),
            };

            // An ID-only copy can bridge groups previously found via iCalUID.
            for (const other of matches) {
                if (other === group) continue;
                for (const key of other.aliases) {
                    group.aliases.add(key);
                    aliases.set(key, group);
                }
                for (const key of other.eventKeys) group.eventKeys.add(key);
                for (const [id, member] of other.calendars) group.calendars.set(id, member);
                groups.delete(other);
            }
            for (const key of keys) {
                group.aliases.add(key);
                aliases.set(key, group);
            }
            group.eventKeys.add(calendarEventKey(calendar.id, event.id));
            group.calendars.set(calendar.id, { id: calendar.id, label: calendar.label || calendar.id });
            groups.add(group);
        }
    }

    const shared = [...groups]
        .filter((group) => group.calendars.size > 1)
        .map((group) => ({ ...group, sortKey: [...group.aliases].sort()[0] }))
        .sort((a, b) => a.start - b.start || a.sortKey.localeCompare(b.sortKey));
    const result = new Map();
    shared.forEach((group, index) => {
        const entry = {
            number: index + 1,
            calendars: [...group.calendars.values()].sort((a, b) => a.id.localeCompare(b.id)),
        };
        for (const key of group.eventKeys) result.set(key, entry);
    });
    return result;
}
