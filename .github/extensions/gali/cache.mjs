// Week-chunked cache in front of the `gali` CLI.
//
// A multi-week availability scan needs (calendars x weeks) invocations, and one
// `gali events ... --ref-mycals` call takes tens of seconds. Without a cache a
// 4-person / 4-week scan costs minutes and every extension reload pays it
// again, so results are memoised in memory *and* on disk under $COPILOT_HOME.
//
// gali's ListEvents fetches a single page (MaxResults 1000) with no
// pagination, so a long range can truncate. Chunking by week is therefore a
// correctness measure as well as a caching convenience; fetchRaw refuses a
// response that still carries a continuation token.

import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { collectCalendar, RESOLVED_TZ, resolveGaliBinary } from "./gali.mjs";

const COPILOT_HOME = process.env.COPILOT_HOME || path.join(homedir(), ".copilot");
// Outside the extension installation directory: an extension update replaces
// that whole directory. See store.mjs.
const CACHE_DIR = path.join(COPILOT_HOME, "gali-calendar", "cache");

const DEFAULT_TTL_MS = 15 * 60_000;
const MAX_CACHE_AGE_MS = 24 * 60 * 60_000;
const MEMORY_LIMIT = 400;

/** key -> { at, value } */
const memory = new Map();

function signature(calendarId, since, until, options, galiBin) {
    const parts = [
        // Bump when the cached record shape or the derived fields change, so
        // entries written by an older build are not served.
        "v6",
        galiBin,
        // gali resolves date-only --since/--until in $TZ, so the same date
        // strings mean different instants under a different timezone.
        RESOLVED_TZ,
        calendarId,
        since,
        until,
        (options.refs || []).join(","),
        options.refMyCals ? "mycals" : "",
        options.building || "",
    ];
    return createHash("sha1").update(parts.join("\u0000")).digest("hex");
}

function remember(key, value, at = Date.now()) {
    // `at` is the time the result was produced, not the time it was promoted
    // from disk: refreshing it there would stretch the TTL past its lifetime.
    memory.set(key, { at, value });
    if (memory.size > MEMORY_LIMIT) {
        const oldest = [...memory.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, memory.size - MEMORY_LIMIT);
        for (const [staleKey] of oldest) memory.delete(staleKey);
    }
}

async function readDisk(key, ttlMs) {
    try {
        const file = path.join(CACHE_DIR, `${key}.json`);
        const info = await stat(file);
        if (Date.now() - info.mtimeMs > ttlMs) return null;
        return { at: info.mtimeMs, value: JSON.parse(await readFile(file, "utf8")) };
    } catch {
        return null;
    }
}

async function writeDisk(key, value) {
    try {
        // Cached payloads hold titles, descriptions and locations: keep them
        // readable only by this user instead of trusting the ambient umask.
        await mkdir(CACHE_DIR, { recursive: true, mode: 0o700 });
        const file = path.join(CACHE_DIR, `${key}.json`);
        await writeFile(file, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
        await chmod(file, 0o600).catch(() => {});
    } catch {
        // A cache write failure must never break a scan.
    }
}

/**
 * One calendar, one week. `collectCalendar` is only invoked on a miss.
 */
export async function fetchWeek(calendarId, since, until, options = {}, { ttlMs = DEFAULT_TTL_MS, force = false } = {}) {
    const key = signature(calendarId, since, until, options, await resolveGaliBinary());

    if (!force) {
        const hit = memory.get(key);
        if (hit && Date.now() - hit.at < ttlMs) return { ...hit.value, cached: true };
        const disk = await readDisk(key, ttlMs);
        if (disk) {
            remember(key, disk.value, disk.at);
            return { ...disk.value, cached: true };
        }
    }

    const result = await collectCalendar(calendarId, {
        since,
        until,
        refs: options.refs || [],
        refMyCals: Boolean(options.refMyCals),
        building: options.building || "",
    });
    const value = {
        summary: result.summary,
        timeZone: result.timeZone,
        accessRole: result.accessRole,
        events: result.events,
    };
    remember(key, value);
    await writeDisk(key, value);
    return { ...value, cached: false };
}

export async function pruneCache() {
    try {
        const entries = await readdir(CACHE_DIR);
        await Promise.all(
            entries.map(async (name) => {
                const file = path.join(CACHE_DIR, name);
                try {
                    const info = await stat(file);
                    if (Date.now() - info.mtimeMs > MAX_CACHE_AGE_MS) await unlink(file);
                } catch {
                    // Already gone.
                }
            }),
        );
    } catch {
        // No cache directory yet.
    }
}

export function clearMemoryCache() {
    memory.clear();
}

export const cacheDir = CACHE_DIR;
