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

import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { collectCalendar, GaliError, RESOLVED_TZ, resolveGaliBinary } from "./gali.mjs";

const COPILOT_HOME = process.env.COPILOT_HOME || path.join(homedir(), ".copilot");
// Outside the extension installation directory: an extension update replaces
// that whole directory. See store.mjs.
const CACHE_DIR = path.join(COPILOT_HOME, "gali-calendar", "cache");

const DEFAULT_TTL_MS = 15 * 60_000;
const MAX_CACHE_AGE_MS = 24 * 60 * 60_000;
const MEMORY_LIMIT = 400;

function signature(calendarId, since, until, options, galiBin) {
    const parts = [
        // Bump when the cached record shape or the derived fields change, so
        // entries written by an older build are not served.
        "v7",
        galiBin,
        // gali resolves date-only --since/--until in $TZ, so the same date
        // strings mean different instants under a different timezone.
        RESOLVED_TZ,
        calendarId,
        since,
        until,
        options.refs || [],
        Boolean(options.refMyCals),
        options.building || "",
    ];
    return createHash("sha1").update(JSON.stringify(parts)).digest("hex");
}

async function readDisk(key) {
    try {
        const file = path.join(CACHE_DIR, `${key}.json`);
        const record = JSON.parse(await readFile(file, "utf8"));
        if (!Number.isFinite(record?.at) || !Array.isArray(record.value?.events)) return null;
        return record;
    } catch {
        return null;
    }
}

async function writeDisk(key, record) {
    let temporary;
    try {
        // Cached payloads hold titles, descriptions and locations: keep them
        // readable only by this user instead of trusting the ambient umask.
        await mkdir(CACHE_DIR, { recursive: true, mode: 0o700 });
        const file = path.join(CACHE_DIR, `${key}.json`);
        temporary = path.join(CACHE_DIR, `.${key}.${randomUUID()}.tmp`);
        await writeFile(temporary, JSON.stringify(record), { encoding: "utf8", mode: 0o600, flag: "wx" });
        await chmod(temporary, 0o600).catch(() => {});
        await rename(temporary, file);
    } catch {
        // A cache write failure must never break a scan.
    } finally {
        if (temporary) await unlink(temporary).catch(() => {});
    }
}

/**
 * Merge overlapping chunks without duplicating long events. If the same
 * occurrence appears in chunks of different ages, prefer the newer copy.
 */
export function mergeEventChunks(chunks) {
    const events = new Map();
    for (const { events: items, at } of chunks) {
        for (const event of items) {
            // Google event IDs identify individual recurring occurrences even
            // if one is moved; a series-wide iCalUID needs the start as well.
            const key = event.id
                ? JSON.stringify(["id", event.id])
                : event.uid
                    ? JSON.stringify(["uid", event.uid, event.start])
                    : JSON.stringify(["event", event]);
            const previous = events.get(key);
            if (!previous || at > previous.at) events.set(key, { event, at });
        }
    }
    return [...events.values()].map(({ event }) => event)
        .sort((a, b) => String(a.start).localeCompare(String(b.start)));
}

function addCalendarDays(iso, days) {
    const date = new Date(`${iso}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
}

export function createCalendarCache({
    read = readDisk,
    write = writeDisk,
    collect = collectCalendar,
    resolveBinary = resolveGaliBinary,
    now = Date.now,
} = {}) {
    const memory = new Map();
    const epochs = new Map();
    const pending = new Map();

    const fresh = (record, ttlMs) => record && Number.isFinite(record.at) && now() - record.at < ttlMs;
    const remember = (key, record) => {
        memory.set(key, record);
        epochs.set(key, (epochs.get(key) || 0) + 1);
        if (memory.size > MEMORY_LIMIT) {
            const oldest = [...memory.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, memory.size - MEMORY_LIMIT);
            for (const [staleKey] of oldest) memory.delete(staleKey);
        }
    };

    async function cachedRecord(key, ttlMs) {
        const hit = memory.get(key);
        if (fresh(hit, ttlMs)) return hit;
        const epoch = epochs.get(key) || 0;
        const disk = await read(key);
        const latest = memory.get(key);
        if (fresh(latest, ttlMs)) return latest;
        if ((epochs.get(key) || 0) !== epoch || !fresh(disk, ttlMs)) return null;
        remember(key, disk);
        return disk;
    }

    async function collectRange(calendarId, options) {
        try {
            return { value: await collect(calendarId, options), at: now() };
        } catch (error) {
            if (!(error instanceof GaliError) || error.code !== "calendar_truncated" || options.since >= options.until) {
                throw error;
            }
            const dayCount = Math.round(
                (Date.parse(`${options.until}T00:00:00Z`) - Date.parse(`${options.since}T00:00:00Z`)) / 86_400_000,
            ) + 1;
            const middle = addCalendarDays(options.since, Math.ceil(dayCount / 2) - 1);
            const first = await collectRange(calendarId, { ...options, until: middle });
            const second = await collectRange(calendarId, { ...options, since: addCalendarDays(middle, 1) });
            return {
                value: {
                    ...second.value,
                    events: mergeEventChunks([
                        { events: first.value.events, at: first.at },
                        { events: second.value.events, at: second.at },
                    ]),
                },
                at: Math.min(first.at, second.at),
            };
        }
    }

    async function fetchWeek(calendarId, since, until, options = {}, {
        ttlMs = DEFAULT_TTL_MS, force = false, cacheOnly = false,
    } = {}) {
        if (force && cacheOnly) throw new TypeError("force and cacheOnly cannot be combined");
        const key = signature(calendarId, since, until, options, await resolveBinary());
        const present = (record, cached) => ({
            ...record.value,
            fetchedAt: new Date(record.at).toISOString(),
            cached,
        });
        if (!force) {
            let active = pending.get(key);
            if (active?.force) return cacheOnly ? null : active.promise;
            const hit = await cachedRecord(key, ttlMs);
            active = pending.get(key);
            if (active?.force) return cacheOnly ? null : active.promise;
            if (hit) return present(hit, true);
            if (cacheOnly) return null;
            if (active) return active.promise;
        }

        const previous = pending.get(key)?.promise;
        const operation = (previous ? previous.catch(() => {}) : Promise.resolve()).then(async () => {
            if (!force) {
                const hit = await cachedRecord(key, ttlMs);
                if (hit) return present(hit, true);
            }
            const record = await collectRange(calendarId, {
                since,
                until,
                refs: options.refs || [],
                refMyCals: Boolean(options.refMyCals),
                building: options.building || "",
            });
            remember(key, record);
            await write(key, record);
            return present(record, false);
        });
        const entry = { promise: operation, force };
        pending.set(key, entry);
        try {
            return await operation;
        } finally {
            if (pending.get(key) === entry) pending.delete(key);
        }
    }

    return { fetchWeek, clearMemoryCache: () => memory.clear() };
}

const cache = createCalendarCache();
export const fetchWeek = (...args) => cache.fetchWeek(...args);
export const clearMemoryCache = () => cache.clearMemoryCache();

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

export const cacheDir = CACHE_DIR;
