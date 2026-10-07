// Thin wrapper around the `gali` CLI (https://github.com/srz-zumix/gali).
//
// Everything the canvas shows comes from `gali ... --format json`, so this
// module is the only place that knows how to spawn the binary and how to turn
// its Google Calendar payloads into the shape the renderer wants.

import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Only a checkout has a repository root three levels up
// (`<repo>/.github/extensions/gali`). An installed copy lives flat in
// `$COPILOT_HOME/extensions/gali-calendar`, where the same relative path would
// point at `~/gali` — a path that belongs to the user, not to this extension.
export function localGaliBin(moduleUrl = import.meta.url) {
    const dir = fileURLToPath(new URL(".", moduleUrl));
    const expected = ["gali", "extensions", ".github"];
    let cursor = dir;
    for (const name of expected) {
        if (basename(cursor) !== name) return null;
        cursor = dirname(cursor);
    }
    return join(cursor, `gali${process.platform === "win32" ? ".exe" : ""}`);
}

const LOCAL_GALI_BIN = localGaliBin();
const DEFAULT_TIMEOUT_MS = 120_000;

// gali resolves date-only --since/--until in $TZ, defaulting to Asia/Tokyo,
// while this process computes days in the host timezone. Pinning TZ keeps the
// fetched window and the analysis on the same day boundaries.
export const RESOLVED_TZ = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || "";

export class GaliError extends Error {
    constructor(message, { exitCode = null, notFound = false } = {}) {
        super(message);
        this.name = "GaliError";
        this.exitCode = exitCode;
        this.notFound = notFound;
    }
}

export async function resolveGaliBinary({ override = process.env.GALI_BIN, localPath = LOCAL_GALI_BIN } = {}) {
    if (override) return override;
    // Not a repository checkout: there is no local build to prefer.
    if (!localPath) return "gali";
    try {
        const info = await stat(localPath);
        if (!info.isFile()) {
            throw new GaliError(`ローカル版 \`${localPath}\` は通常のファイルではありません。`);
        }
        return localPath;
    } catch (error) {
        if (error.code === "ENOENT") return "gali";
        if (error instanceof GaliError) throw error;
        throw new GaliError(`ローカル版 \`${localPath}\` を確認できませんでした: ${error.message}`);
    }
}

// `gali` reports failures through log.Fatalf, which prefixes every line with a
// "2006/01/02 15:04:05 " timestamp. Strip it so the canvas can show the message.
function cleanMessage(text) {
    return String(text || "")
        .split("\n")
        .map((line) => line.replace(/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}\s*/, "").trim())
        .filter(Boolean)
        .join("\n");
}

async function runGali(args, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const galiBin = await resolveGaliBinary();
    return new Promise((resolve, reject) => {
        execFile(
            galiBin,
            args,
            {
                timeout: timeoutMs,
                maxBuffer: 32 * 1024 * 1024,
                encoding: "utf8",
                env: RESOLVED_TZ ? { ...process.env, TZ: RESOLVED_TZ } : process.env,
            },
            (error, stdout, stderr) => {
                if (!error) {
                    resolve(stdout);
                    return;
                }
                if (error.code === "ENOENT") {
                    reject(
                        new GaliError(
                            `\`${galiBin}\` コマンドが見つかりません。\`make build\` または \`brew install srz-zumix/tap/gali\` で用意するか、GALI_BIN 環境変数でパスを指定してください。`,
                            { notFound: true },
                        ),
                    );
                    return;
                }
                const message = cleanMessage(stderr) || cleanMessage(stdout) || error.message;
                reject(new GaliError(message, { exitCode: error.code ?? null }));
            },
        );
    });
}

function parseJson(stdout) {
    const start = stdout.indexOf("{");
    if (start < 0) {
        throw new GaliError("gali の出力に JSON が含まれていませんでした。");
    }
    try {
        return JSON.parse(stdout.slice(start));
    } catch (error) {
        throw new GaliError(`gali の JSON 出力を解析できませんでした: ${error.message}`);
    }
}

/** `gali list --format json` — the calendars the signed-in user can already see. */
export async function listCalendars() {
    const data = parseJson(await runGali(["list", "--format", "json"]));
    return (data.items || [])
        .filter((entry) => entry && entry.id)
        .map((entry) => ({
            id: entry.id,
            summary: entry.summaryOverride || entry.summary || entry.id,
            description: entry.description || "",
            primary: Boolean(entry.primary),
            accessRole: entry.accessRole || "",
            backgroundColor: entry.backgroundColor || "",
        }));
}

// The response status of the calendar owner, which is what tells us whether the
// person we are looking at actually accepted the meeting.
function ownerResponseStatus(event) {
    for (const attendee of event.attendees || []) {
        if (attendee.self && attendee.responseStatus) {
            return attendee.responseStatus;
        }
    }
    return "";
}

// Roles that can read `visibility: "private"` details, so a private event with a
// title on such a calendar is genuinely readable and not borrowed.
const PRIVATE_READING_ROLES = new Set(["owner", "writer"]);

// Older CLIs have no provenance marker. Keep their inferred badge, but never
// present the inference as a known source calendar.
function inferCompleted(event, accessRole) {
    if (!event.summary) return false;
    if (PRIVATE_READING_ROLES.has(accessRole)) return false;
    if (accessRole === "freeBusyReader") return event.visibility !== "public";
    return event.visibility === "private";
}

function normalizeEvent(event, calendarId, accessRole) {
    const allDay = Boolean(event.start && event.start.date);
    const summary = event.summary || "";
    const start = allDay ? event.start.date : (event.start && event.start.dateTime) || "";
    const end = allDay ? (event.end && event.end.date) || "" : (event.end && event.end.dateTime) || "";
    const completedFrom = event.extendedProperties?.private?.["gali.completedFrom"] || "";
    const completedFromName = completedFrom ? event.extendedProperties?.private?.["gali.completedFromName"] || "" : "";
    const completionInferred = !completedFrom && inferCompleted(event, accessRole);
    return {
        id: event.id || "",
        // iCalUID is stable across every attendee's copy of an invitation, so it
        // is what lets us tell "these four people are in the same meeting" apart
        // from "these four people happen to be busy at the same time".
        uid: event.iCalUID || event.id || "",
        calendarId,
        summary,
        // Empty summary means the calendar is only shared as free/busy, so the
        // title is the one piece of information we are not allowed to see.
        detailsVisible: summary !== "",
        location: event.location || "",
        description: event.description || "",
        allDay,
        start,
        end,
        durationMinutes: allDay ? 0 : durationMinutes(start, end),
        status: event.status || "",
        visibility: event.visibility || "",
        transparency: event.transparency || "",
        eventType: event.eventType || "",
        recurring: Boolean(event.recurringEventId),
        recurringEventId: event.recurringEventId || "",
        responseStatus: ownerResponseStatus(event),
        attendeeCount: (event.attendees || []).length,
        organizer: (event.organizer && (event.organizer.email || event.organizer.displayName)) || "",
        htmlLink: event.htmlLink || "",
        completed: Boolean(completedFrom) || completionInferred,
        completedFrom,
        completedFromName,
        completionInferred,
    };
}

function durationMinutes(start, end) {
    const from = new Date(start).getTime();
    const to = new Date(end).getTime();
    if (Number.isNaN(from) || Number.isNaN(to) || to <= from) return 0;
    return Math.round((to - from) / 60_000);
}

function buildEventArgs(calendarId, { since, until, refs = [], refMyCals = false, building = "" }) {
    const args = ["events", calendarId, "--since", since, "--until", until, "--format", "json"];
    for (const ref of refs) {
        if (ref) args.push("--ref", ref);
    }
    if (refMyCals) args.push("--ref-mycals");
    if (building) args.push("--building", building);
    return args;
}

async function fetchRaw(calendarId, options) {
    const data = parseJson(await runGali(buildEventArgs(calendarId, options)));
    // gali's ListEvents does not paginate, so a truncated page would silently
    // turn busy time into free time. Refuse the answer instead of guessing.
    if (data.nextPageToken) {
        throw new GaliError(
            `${calendarId} の ${options.since}〜${options.until} は件数が多く、gali が全件を取得できませんでした（ページング未対応）。期間を短くしてください。`,
        );
    }
    return {
        summary: data.summary || calendarId,
        timeZone: data.timeZone || "",
        // Used only for the legacy inference when the CLI has no source marker.
        accessRole: data.accessRole || "",
        items: data.items || [],
    };
}

export function hasReferences({ refs = [], refMyCals = false, building = "" }) {
    return refs.filter(Boolean).length > 0 || refMyCals || Boolean(building);
}

/**
 * Fetch one calendar.
 *
 * gali always uses `primary` as a reference calendar, so there is no way to ask
 * it for an uncompleted baseline; a second "bare" fetch would only double the
 * cost without revealing which titles were borrowed. Read gali's source marker
 * instead; accessRole inference is only a compatibility fallback for older CLIs.
 */
export async function collectCalendar(calendarId, options) {
    const primary = await fetchRaw(calendarId, options);
    let events = primary.items.map((event) => normalizeEvent(event, calendarId, primary.accessRole));

    events = events.filter((event) => event.status !== "cancelled" && event.start);
    events.sort((a, b) => String(a.start).localeCompare(String(b.start)));
    return { summary: primary.summary, timeZone: primary.timeZone, accessRole: primary.accessRole, events };
}
