// Extension: gali-calendar
//
// A canvas that renders other people's Google Calendar availability using the
// `gali` CLI from this repository. Everything shown is what gali is allowed to
// read: full details where the calendar is shared with details, and a masked
// "予定あり（詳細非公開）" block where only free/busy is shared. gali's reference
// calendars (`--ref`, `--ref-mycals`, `--building`) can fill in titles for
// private events, and the canvas marks those so you can tell them apart.
//
// Wiring only — the interesting parts live in the sibling modules:
//   gali.mjs      spawn the CLI, normalize Google Calendar payloads
//   store.mjs     durable per-profile settings under $COPILOT_HOME
//   state.mjs     shared per-profile state + fetch orchestration
//   freebusy.mjs  free/busy math
//   server.mjs    loopback HTTP server + SSE
//   ui/           the iframe renderer

import { joinSession, createCanvas, CanvasError } from "@github/copilot-sdk/extension";

import { listCalendars, GaliError } from "./gali.mjs";
import { formatMinutes } from "./freebusy.mjs";
import { normalizeProfile, PROFILE_PATTERN, settingsFileFor } from "./store.mjs";
import { getProfileState, todayISO } from "./state.mjs";
import { startServer } from "./server.mjs";

const VIEWS = ["day", "3days", "week"];
const DATE_PATTERN = "^\\d{4}-\\d{2}-\\d{2}$";
const TIME_PATTERN = "^([01]\\d|2[0-3]):[0-5]\\d$";
const GRID_HEIGHT_SCHEMA = {
    type: "integer",
    minimum: 0,
    description: "Calendar viewport height in pixels (minimum 180). Zero restores automatic sizing.",
};

/** instanceId -> { profile, server, url, inputKey } */
const instances = new Map();

function instanceFor(ctx) {
    const entry = instances.get(ctx.instanceId);
    if (!entry) {
        throw new CanvasError("canvas_instance_unknown", `canvas instance ${ctx.instanceId} is not open`);
    }
    return entry;
}

async function stateFor(ctx) {
    return getProfileState(instanceFor(ctx).profile);
}

/** Only the keys the caller actually supplied become settings overrides. */
function overridesFromInput(input) {
    const source = input && typeof input === "object" ? input : {};
    const overrides = {};
    for (const key of [
        "calendars",
        "view",
        "anchor",
        "refs",
        "refMyCals",
        "building",
        "showDeclined",
        "showCompletionDiff",
        "workStart",
        "workEnd",
        "showFreeSlots",
        "gridHeight",
        "slotMinutes",
        "scanWeeks",
        "scanWeekdaysOnly",
        "holidayCalendarId",
        "skipHolidays",
        "skipPolicySlots",
        "policyPatterns",
        "awayRatio",
        "treatAwayAsBusy",
    ]) {
        if (source[key] !== undefined) overrides[key] = source[key];
    }
    return overrides;
}

function calendarIdsFrom(input) {
    const value = (input || {}).calendars;
    const list = Array.isArray(value) ? value : [value];
    const ids = list.map((item) => String(item || "").trim()).filter(Boolean);
    if (!ids.length) {
        throw new CanvasError("canvas_input_invalid", "calendars には少なくとも 1 件のカレンダー ID が必要です");
    }
    return ids;
}

function summarizeCalendar(calendar, includeEvents) {
    const base = {
        id: calendar.id,
        label: calendar.label,
        // owner / writer / reader / freeBusyReader — how much of this calendar
        // we can actually read.
        accessRole: calendar.accessRole || null,
        error: calendar.error,
        total: calendar.stats.total,
        detailsHidden: calendar.stats.hidden,
        declined: calendar.stats.declined,
    };
    if (!includeEvents) return base;
    return {
        ...base,
        events: calendar.events.map((event) => ({
            start: event.start,
            end: event.end,
            allDay: event.allDay,
            title: event.detailsVisible ? event.summary : null,
            detailsVisible: event.detailsVisible,
            completedFromReference: event.completed,
            completedFrom: event.completedFrom || null,
            completedFromName: event.completedFromName || null,
            completionInferred: Boolean(event.completionInferred),
            responseStatus: event.responseStatus || null,
            busy: event.transparency !== "transparent",
            location: event.location || null,
        })),
    };
}

function describe(state, { includeEvents = false } = {}) {
    const payload = state.toJSON();
    return {
        profile: payload.profile,
        settingsFile: settingsFileFor(payload.profile),
        view: payload.settings.view,
        range: payload.range,
        loading: payload.loading,
        error: payload.error,
        usingReferences: Boolean(payload.snapshot && payload.snapshot.usingReferences),
        fetchedAt: payload.snapshot ? payload.snapshot.fetchedAt : null,
        calendars: payload.snapshot
            ? payload.snapshot.calendars.map((calendar) => summarizeCalendar(calendar, includeEvents))
            : payload.settings.calendars.map((entry) => ({ id: entry.id, label: entry.label || entry.id })),
        freeSlots: payload.freeSlots.map(({ day, slots }) => ({
            day,
            slots: slots.map(([start, end]) => `${formatMinutes(start)}-${formatMinutes(end)}`),
        })),
    };
}

async function mutate(ctx, patch, { refresh = true } = {}) {
    const state = await stateFor(ctx);
    await state.updateSettings(patch, { refresh });
    return describe(state);
}

function requireCalendars(state) {
    if (!state.settings.calendars.length) {
        throw new CanvasError("canvas_input_invalid", "カレンダーが1件も設定されていません。add_calendars で追加してください。");
    }
}

function requireScan(state) {
    if (!state.scan) {
        throw new CanvasError("scan_unavailable", state.error || "スキャン結果がありません。find_slots を先に実行してください。");
    }
    return state.scan;
}

/**
 * Turn the raw scan into the story the caller needs: the openings, and — when
 * there are none — the reason, because "no availability" on its own sends people
 * off rescheduling meetings that would not have helped.
 */
function buildHint(scan) {
    const notes = [];
    const sole = scan.blockers.find((blocker) => blocker.soleBlocker > 0);
    if (sole) {
        const away = sole.awaySlots > sole.meetingSlots;
        notes.push(
            away
                ? `${sole.label} は ${sole.awaySlots} 枠で終日ブロック（不在の可能性）です。会議を動かしても空きません。`
                : `${sole.label} が ${sole.soleBlocker} 枠で唯一のブロッカーです。この人の会議を1つ動かせば枠が開きます。`,
        );
    }
    if (!scan.totalFreeSlots) notes.push("この期間に全員が空く枠はありません。期間を延ばすか参加者を減らしてください。");
    const together = scan.sharedMeetings.filter((meeting) => meeting.attendeeCount >= scan.calendars.length);
    if (together.length) {
        notes.push(`「${together[0].title}」には既に全員が参加しています。ここを延長すれば調整は不要です。`);
    }
    if (scan.holidays.length) notes.push(`${scan.holidays.length} 日を祝日として除外しました。`);
    return notes;
}

function summarizeScan(state, { limit }) {
    const scan = requireScan(state);
    return {
        range: { from: scan.from, until: scan.until, weeks: scan.weeks, weekdaysOnly: scan.weekdaysOnly },
        durationMinutes: scan.durationMinutes,
        scannedSlots: scan.scannedSlots,
        totalFreeSlots: scan.totalFreeSlots,
        candidates: scan.candidates.slice(0, limit),
        holidays: scan.holidays,
        calendars: scan.calendars,
        hint: buildHint(scan),
    };
}

async function closeInstance(instanceId) {
    const entry = instances.get(instanceId);
    if (!entry) return;
    instances.delete(instanceId);
    await entry.close();
}

const canvas = createCanvas({
    id: "gali-calendar",
    displayName: "gali カレンダー",
    description:
        "Show other people's Google Calendar availability from the gali CLI as a day/week grid, including free/busy-only events and shared free slots.",
    inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
            profile: {
                type: "string",
                pattern: PROFILE_PATTERN.source,
                description: "Named saved view. Settings persist per profile. Defaults to 'default'.",
            },
            calendars: {
                type: "array",
                items: { type: "string" },
                description: "Calendar IDs / email addresses to display.",
            },
            view: { type: "string", enum: VIEWS },
            anchor: { type: "string", pattern: DATE_PATTERN, description: "Date to focus (YYYY-MM-DD)." },
            refs: {
                type: "array",
                items: { type: "string" },
                description: "Reference calendar IDs used to complete private events (gali --ref).",
            },
            refMyCals: { type: "boolean", description: "Use all of my calendars as references (gali --ref-mycals)." },
            building: {
                type: "string",
                description: "Building ID whose rooms are used as references (gali --building).",
            },
            showDeclined: { type: "boolean" },
            showCompletionDiff: {
                type: "boolean",
                description:
                    "Show completion badges and their source calendars. Older CLIs show an inferred 補? badge with an unknown source. Display only; no extra gali call.",
            },
            workStart: { type: "string", pattern: TIME_PATTERN },
            workEnd: { type: "string", pattern: TIME_PATTERN },
            showFreeSlots: { type: "boolean" },
            gridHeight: GRID_HEIGHT_SCHEMA,
            slotMinutes: { type: "integer", minimum: 15, maximum: 480, description: "Default meeting length for the availability scan." },
            scanWeeks: { type: "integer", minimum: 1, maximum: 12, description: "How many weeks ahead the scan looks." },
            scanWeekdaysOnly: { type: "boolean" },
            holidayCalendarId: { type: "string", description: "Calendar whose all-day events mark holidays to skip." },
            skipHolidays: { type: "boolean" },
            skipPolicySlots: { type: "boolean" },
            policyPatterns: {
                type: "array",
                items: { type: "string" },
                description: "Title fragments marking a protected slot (e.g. a no-meeting day).",
            },
            awayRatio: { type: "number", minimum: 0.3, maximum: 1 },
            treatAwayAsBusy: { type: "boolean", description: "Whether all-day style blocks count as busy." },
        },
    },
    actions: [
        {
            name: "add_calendars",
            description: "Add calendar IDs (email addresses) to the canvas and refetch.",
            inputSchema: {
                type: "object",
                additionalProperties: false,
                required: ["calendars"],
                properties: { calendars: { type: "array", items: { type: "string" }, minItems: 1 } },
            },
            handler: async (ctx) => {
                const ids = calendarIdsFrom(ctx.input);
                // Derived from the settings held under the lock, so a second
                // add running at the same time cannot drop this one.
                return mutate(ctx, (settings) => ({
                    calendars: [...settings.calendars, ...ids.map((id) => ({ id, label: "" }))],
                }));
            },
        },
        {
            name: "remove_calendars",
            description: "Remove calendar IDs from the canvas.",
            inputSchema: {
                type: "object",
                additionalProperties: false,
                required: ["calendars"],
                properties: { calendars: { type: "array", items: { type: "string" }, minItems: 1 } },
            },
            handler: async (ctx) => {
                const remove = new Set(calendarIdsFrom(ctx.input));
                return mutate(ctx, (settings) => ({
                    calendars: settings.calendars.filter((entry) => !remove.has(entry.id)),
                }));
            },
        },
        {
            name: "set_range",
            description: "Change the displayed period: view mode and/or the focused date.",
            inputSchema: {
                type: "object",
                additionalProperties: false,
                properties: {
                    view: { type: "string", enum: VIEWS },
                    anchor: { type: "string", pattern: DATE_PATTERN },
                    today: { type: "boolean", description: "Jump to today." },
                },
            },
            handler: async (ctx) => {
                const input = ctx.input || {};
                const patch = {};
                if (input.view) patch.view = input.view;
                if (input.today) patch.anchor = todayISO();
                else if (input.anchor) patch.anchor = input.anchor;
                if (!Object.keys(patch).length) {
                    throw new CanvasError("canvas_input_invalid", "view / anchor / today のいずれかを指定してください");
                }
                return mutate(ctx, patch);
            },
        },
        {
            name: "set_references",
            description: "Configure gali's private-event completion (--ref / --ref-mycals / --building) and refetch.",
            inputSchema: {
                type: "object",
                additionalProperties: false,
                properties: {
                    refs: { type: "array", items: { type: "string" } },
                    refMyCals: { type: "boolean" },
                    building: { type: "string" },
                    showCompletionDiff: { type: "boolean" },
                },
            },
            handler: async (ctx) => mutate(ctx, overridesFromInput(ctx.input)),
        },
        {
            name: "set_display",
            description: "Change display-only options (declined events, free-slot panel, working hours, viewport height) and scan tuning.",
            inputSchema: {
                type: "object",
                additionalProperties: false,
                properties: {
                    showDeclined: { type: "boolean" },
                    showFreeSlots: { type: "boolean" },
                    gridHeight: GRID_HEIGHT_SCHEMA,
                    workStart: { type: "string", pattern: TIME_PATTERN },
                    workEnd: { type: "string", pattern: TIME_PATTERN },
                    slotMinutes: { type: "integer", minimum: 15, maximum: 480 },
                    scanWeeks: { type: "integer", minimum: 1, maximum: 12 },
                    scanWeekdaysOnly: { type: "boolean" },
                    holidayCalendarId: { type: "string" },
                    skipHolidays: { type: "boolean" },
                    skipPolicySlots: { type: "boolean" },
                    policyPatterns: { type: "array", items: { type: "string" } },
                    awayRatio: { type: "number", minimum: 0.3, maximum: 1 },
                    treatAwayAsBusy: { type: "boolean" },
                },
            },
            handler: async (ctx) => mutate(ctx, overridesFromInput(ctx.input), { refresh: false }),
        },
        {
            name: "refresh",
            description: "Re-run gali for the current calendars and period.",
            handler: async (ctx) => {
                const state = await stateFor(ctx);
                await state.refresh({ force: true });
                return describe(state);
            },
        },
        {
            name: "get_schedule",
            description:
                "Read what the canvas currently shows: per-calendar stats, shared free slots, and optionally every event.",
            inputSchema: {
                type: "object",
                additionalProperties: false,
                properties: { includeEvents: { type: "boolean", description: "Include the individual events." } },
            },
            handler: async (ctx) => {
                const state = await stateFor(ctx);
                if (!state.snapshot && !state.loading && state.settings.calendars.length) {
                    await state.refresh();
                }
                return describe(state, { includeEvents: Boolean((ctx.input || {}).includeEvents) });
            },
        },
        {
            name: "list_available_calendars",
            description: "List the calendars the signed-in user can already see (gali list).",
            inputSchema: { type: "object", additionalProperties: false, properties: {} },
            handler: async () => {
                try {
                    return { calendars: await listCalendars() };
                } catch (error) {
                    throw new CanvasError(
                        "gali_failed",
                        error instanceof GaliError ? error.message : String(error && error.message),
                    );
                }
            },
        },
        {
            name: "find_slots",
            description:
                "Scan several weeks ahead for slots where every watched calendar is free for a given meeting length. Skips holidays and no-meeting policy blocks, and ranks openings that sit next to a meeting everyone already attends.",
            inputSchema: {
                type: "object",
                additionalProperties: false,
                properties: {
                    durationMinutes: { type: "integer", minimum: 15, maximum: 480, description: "Meeting length. Defaults to the saved slotMinutes." },
                    weeks: { type: "integer", minimum: 1, maximum: 12, description: "How many weeks ahead to scan." },
                    from: { type: "string", pattern: DATE_PATTERN, description: "First day of the scan. Defaults to today." },
                    force: { type: "boolean", description: "Bypass the fetch cache." },
                    limit: { type: "integer", minimum: 1, maximum: 100 },
                },
            },
            handler: async (ctx) => {
                const state = await stateFor(ctx);
                const input = ctx.input || {};
                requireCalendars(state);
                await state.scanAvailability(input, { force: Boolean(input.force) });
                return summarizeScan(state, { limit: input.limit || 20 });
            },
        },
        {
            name: "analyze_blockers",
            description:
                "Explain why a period has no availability: who blocks the most slots, who is the sole blocker, whether their block is an all-day absence rather than a movable meeting, and which slots are one person away from working.",
            inputSchema: {
                type: "object",
                additionalProperties: false,
                properties: {
                    durationMinutes: { type: "integer", minimum: 15, maximum: 480 },
                    weeks: { type: "integer", minimum: 1, maximum: 12 },
                    from: { type: "string", pattern: DATE_PATTERN },
                    rescan: { type: "boolean", description: "Re-run the scan instead of reusing the last one." },
                },
            },
            handler: async (ctx) => {
                const state = await stateFor(ctx);
                const input = ctx.input || {};
                requireCalendars(state);
                if (!state.scan || input.rescan || input.durationMinutes || input.weeks || input.from) {
                    await state.scanAvailability(input, { force: Boolean(input.rescan) });
                }
                const scan = requireScan(state);
                return {
                    range: { from: scan.from, until: scan.until, durationMinutes: scan.durationMinutes },
                    freeSlots: scan.totalFreeSlots,
                    blockers: scan.blockers,
                    nearMiss: scan.nearMiss,
                    hint: buildHint(scan),
                };
            },
        },
        {
            name: "find_shared_meetings",
            description:
                "List meetings that more than one watched calendar attends, matched across calendars by iCalUID. A recurring meeting that already has everyone can simply be extended instead of scheduling a new one.",
            inputSchema: {
                type: "object",
                additionalProperties: false,
                properties: {
                    minAttendees: { type: "integer", minimum: 2, maximum: 20 },
                    rescan: { type: "boolean" },
                },
            },
            handler: async (ctx) => {
                const state = await stateFor(ctx);
                const input = ctx.input || {};
                requireCalendars(state);
                if (!state.scan || input.rescan) await state.scanAvailability({}, { force: Boolean(input.rescan) });
                const scan = requireScan(state);
                const min = input.minAttendees || 2;
                return {
                    range: { from: scan.from, until: scan.until },
                    meetings: scan.sharedMeetings
                        .map((meeting, index) => ({ index, ...meeting }))
                        .filter((meeting) => meeting.attendeeCount >= min),
                };
            },
        },
        {
            name: "simulate_reschedule",
            description:
                "What-if: drop one shared meeting and report how many new slots that would open. Answers whether rescheduling is worth proposing at all.",
            inputSchema: {
                type: "object",
                additionalProperties: false,
                properties: {
                    title: { type: "string", description: "Title of a meeting from find_shared_meetings." },
                    index: {
                        type: "integer",
                        minimum: 0,
                        description: "Position from find_shared_meetings. Use this when several meetings share a title (e.g. all private ones).",
                    },
                },
            },
            handler: async (ctx) => {
                const state = await stateFor(ctx);
                requireCalendars(state);
                if (!state.scan) await state.scanAvailability({});
                const scan = requireScan(state);
                const input = ctx.input || {};
                const wanted = String(input.title || "").trim();
                let meeting = null;
                if (Number.isInteger(input.index)) {
                    meeting = scan.sharedMeetings[input.index] || null;
                } else if (wanted) {
                    meeting = scan.sharedMeetings.find((entry) => entry.title === wanted)
                        || scan.sharedMeetings.find((entry) => entry.title.includes(wanted));
                }
                if (!meeting) {
                    throw new CanvasError(
                        "canvas_input_invalid",
                        wanted || Number.isInteger(input.index)
                            ? `「${wanted || input.index}」に一致する共有会議が見つかりません。find_shared_meetings で候補を確認してください。`
                            : "title か index のどちらかを指定してください。",
                    );
                }
                const result = state.whatIf(meeting.keys);
                return {
                    meeting: { title: meeting.title, attendees: meeting.attendees, occurrences: meeting.occurrences },
                    ...result,
                    verdict:
                        result && result.delta > 0
                            ? `この会議を動かすと ${result.delta} 枠が新たに空きます。`
                            : "この会議を動かしても新たな枠は生まれません（別のブロッカーが残ります）。",
                };
            },
        },
    ],

    open: async (ctx) => {
        const input = ctx.input && typeof ctx.input === "object" ? ctx.input : {};
        const profile = normalizeProfile(input.profile);
        const inputKey = JSON.stringify(input);
        const existing = instances.get(ctx.instanceId);

        // Re-opens (host focus, provider reconnect, extensions_reload) replay the
        // same input. Applying those overrides again would clobber edits made in
        // the UI since, so only apply them when the input actually changed.
        const isReplay = Boolean(existing && existing.inputKey === inputKey);
        const state = await getProfileState(profile, isReplay ? null : overridesFromInput(input));

        let entry = existing;
        if (!entry || entry.profile !== profile) {
            if (entry) await closeInstance(ctx.instanceId);
            entry = { profile, ...(await startServer({ profile, instanceId: ctx.instanceId })) };
        }
        entry.inputKey = inputKey;
        instances.set(ctx.instanceId, entry);

        // A re-open with new input saved new settings, so the snapshot on
        // screen is for the previous calendars/date. Refetch (and publish) in
        // that case too, not only when nothing has been fetched yet.
        const hasCalendars = state.settings.calendars.length > 0;
        if ((hasCalendars && (!isReplay || !state.snapshot)) || (!isReplay && state.snapshot)) {
            state.refresh().catch(() => {});
        }

        return {
            title: profile === "default" ? "gali カレンダー" : `gali カレンダー (${profile})`,
            url: entry.url,
            status: state.settings.calendars.length
                ? `${state.settings.calendars.length} 件のカレンダー`
                : "カレンダー未設定",
        };
    },

    onClose: async (ctx) => {
        await closeInstance(ctx.instanceId);
    },
});

await joinSession({ canvases: [canvas] });
