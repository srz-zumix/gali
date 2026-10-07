// Per-profile shared state: settings, the last fetched snapshot, and the
// subscribers (SSE clients) that need to know when either changes.
//
// State is keyed by profile — never by canvas instance — so two panels showing
// the same profile stay in sync and a reload rehydrates from disk.

import { collectCalendar, GaliError, hasReferences } from "./gali.mjs";
import { computeFreeSlots } from "./freebusy.mjs";
import { fetchWeek, pruneCache } from "./cache.mjs";
import { holidayDatesFrom } from "./classify.mjs";
import {
    analyzeBlockers,
    buildIndex,
    enumerateDays,
    findSharedMeetings,
    findSlots,
    simulateReschedule,
    weekChunks,
} from "./analysis.mjs";
import { loadSettings, saveSettings, sanitizeSettings, normalizeProfile } from "./store.mjs";

const PALETTE = [
    "#3f7ee8",
    "#c9631a",
    "#2f8f5b",
    "#8a5cd6",
    "#c2436f",
    "#0f8a9b",
    "#8a7a1f",
    "#5a6b8a",
];

const FETCH_CONCURRENCY = 3;

// Settings the availability scan is derived from. The displayed range is not
// one of them: paging the grid must not throw a scan away.
const SCAN_INPUTS = [
    "calendars",
    "refs",
    "refMyCals",
    "building",
    "workStart",
    "workEnd",
    "slotMinutes",
    "scanWeeks",
    "scanWeekdaysOnly",
    "holidayCalendarId",
    "skipHolidays",
    "skipPolicySlots",
    "policyPatterns",
    "awayRatio",
    "treatAwayAsBusy",
];

function scanInputsChanged(before, after) {
    if (!before) return false;
    return SCAN_INPUTS.some((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
}

export function pad2(value) {
    return String(value).padStart(2, "0");
}

export function toISODate(date) {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export function todayISO() {
    return toISODate(new Date());
}

function parseISODate(iso) {
    const [year, month, day] = String(iso).split("-").map(Number);
    return new Date(year, month - 1, day);
}

export function addDays(iso, amount) {
    const date = parseISODate(iso);
    date.setDate(date.getDate() + amount);
    return toISODate(date);
}

function startOfWeek(iso) {
    const date = parseISODate(iso);
    // Monday-first week.
    const offset = (date.getDay() + 6) % 7;
    date.setDate(date.getDate() - offset);
    return toISODate(date);
}

export function resolveRange(settings) {
    const anchor = settings.anchor || todayISO();
    let first = anchor;
    let length = 1;
    if (settings.view === "week") {
        first = startOfWeek(anchor);
        length = 7;
    } else if (settings.view === "3days") {
        length = 3;
    }
    const days = Array.from({ length }, (_, index) => addDays(first, index));
    return { since: days[0], until: days[days.length - 1], days, anchor };
}

/** Move the anchor by one whole page in the current view. */
export function shiftAnchor(settings, direction) {
    const step = settings.view === "week" ? 7 : settings.view === "3days" ? 3 : 1;
    const range = resolveRange(settings);
    return addDays(range.days[0], direction * step);
}

async function mapWithConcurrency(items, limit, worker) {
    const results = new Array(items.length);
    let cursor = 0;
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (cursor < items.length) {
            const index = cursor;
            cursor += 1;
            results[index] = await worker(items[index], index);
        }
    });
    await Promise.all(runners);
    return results;
}

class ProfileState {
    constructor(profile) {
        this.profile = profile;
        this.settings = null;
        this.snapshot = null;
        this.error = null;
        this.loading = false;
        this.listeners = new Set();
        this.inFlight = null;
        this.log = null;
        // Availability scan, independent of the displayed range.
        this.scan = null;
        this.scanProgress = null;
        this.scanInFlight = null;
        this.scanInFlightKey = null;
        this.scanCalendars = null;
        this.inFlightKey = null;
        // Queue tails, kept apart from the active run above.
        this.queuedFetch = null;
        this.queuedFetchKey = null;
        this.queuedScan = null;
        this.queuedScanKey = null;
        // Serializes read/merge/save so two panels (or two quick edits) cannot
        // both merge onto the same stale settings and lose one of the patches.
        this.settingsLock = Promise.resolve();
        this.settingsLoad = null;
    }

    /** Run `task` after every settings mutation queued before it. */
    #locked(task) {
        const next = this.settingsLock.then(task, task);
        this.settingsLock = next.then(
            () => {},
            () => {},
        );
        return next;
    }

    subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    publish() {
        const payload = this.toJSON();
        for (const listener of this.listeners) {
            try {
                listener(payload);
            } catch {
                // A dead SSE client must never break the others.
            }
        }
    }

    toJSON() {
        return {
            profile: this.profile,
            settings: this.settings,
            snapshot: this.snapshot,
            // Recomputed on every publish so working-hour changes apply
            // without re-hitting the API.
            freeSlots: this.settings ? computeFreeSlots(this.snapshot, this.settings) : [],
            error: this.error,
            loading: this.loading,
            range: this.settings ? resolveRange(this.settings) : null,
            scan: this.scan,
            scanProgress: this.scanProgress,
        };
    }

    /**
     * `patch` may be a plain object or a function of the *current* settings.
     * Callers that derive a value from the existing settings (adding a
     * calendar, removing one, moving the anchor) must pass a function: anything
     * computed before the lock is taken can be built on settings another
     * request has already replaced, silently dropping that request's change.
     */
    async updateSettings(patch, { refresh = true } = {}) {
        await this.#locked(async () => {
            const before = this.settings;
            const resolved = typeof patch === "function" ? patch(this.settings) : patch;
            const next = sanitizeSettings({ ...this.settings, ...resolved });
            this.settings = await saveSettings(this.profile, next);
            // Anything the scan was computed from changed, so the stored scan
            // (and the what-if index built with it) no longer describes these
            // settings. Range navigation is display-only and does not count.
            if (scanInputsChanged(before, this.settings)) this.invalidateScan();
        });
        this.publish();
        if (refresh) await this.refresh();
        return this.settings;
    }

    invalidateScan() {
        this.scan = null;
        this.scanIndex = null;
        this.scanDays = null;
        this.scanHolidays = null;
        this.scanSettings = null;
        this.scanCalendars = null;
    }

    /** Everything the displayed snapshot depends on. */
    #fetchKey() {
        const settings = this.settings;
        const range = resolveRange(settings);
        return JSON.stringify([
            range.since,
            range.until,
            settings.calendars.map((entry) => entry.id),
            settings.refs,
            settings.refMyCals,
            settings.building,
        ]);
    }

    async refresh({ force = false } = {}) {
        const key = this.#fetchKey();
        if (this.inFlight && !force && this.inFlightKey === key) return this.inFlight;
        // The tail is tracked separately from the active fetch: chaining onto
        // `inFlight` would lose an already queued request the moment the next
        // one starts, and two of them would then run (and publish) at once.
        if (this.queuedFetch && !force && this.queuedFetchKey === key) return this.queuedFetch;
        const tail = this.queuedFetch || this.inFlight;
        if (tail) {
            // Never run two fetches at once: the slower one would publish over
            // the newer result. Queue instead, so the latest settings win.
            const queued = tail.catch(() => {}).then(() => this.#startFetch());
            this.queuedFetch = queued;
            this.queuedFetchKey = key;
            queued.catch(() => {}).then(() => {
                if (this.queuedFetch === queued) {
                    this.queuedFetch = null;
                    this.queuedFetchKey = null;
                }
            });
            return queued;
        }
        return this.#startFetch();
    }

    #startFetch() {
        const started = this.#fetch().finally(() => {
            if (this.inFlight === started) {
                this.inFlight = null;
                this.inFlightKey = null;
            }
        });
        this.inFlight = started;
        this.inFlightKey = this.#fetchKey();
        return started;
    }

    async #fetch() {
        this.loading = true;
        this.error = null;
        this.publish();
        try {
            const settings = this.settings;
            const range = resolveRange(settings);
            const options = {
                since: range.since,
                until: range.until,
                refs: settings.refs,
                refMyCals: settings.refMyCals,
                building: settings.building,
            };

            const calendars = await mapWithConcurrency(settings.calendars, FETCH_CONCURRENCY, async (entry, index) => {
                const base = {
                    id: entry.id,
                    label: entry.label || entry.id,
                    color: PALETTE[index % PALETTE.length],
                };
                try {
                    const result = await collectCalendar(entry.id, options);
                    const hidden = result.events.filter((event) => !event.detailsVisible).length;
                    const declined = result.events.filter((event) => event.responseStatus === "declined").length;
                    return {
                        ...base,
                        label: entry.label || result.summary || entry.id,
                        summary: result.summary,
                        timeZone: result.timeZone,
                        accessRole: result.accessRole,
                        events: result.events,
                        error: null,
                        stats: { total: result.events.length, hidden, declined },
                    };
                } catch (error) {
                    return {
                        ...base,
                        summary: entry.id,
                        timeZone: "",
                        accessRole: "",
                        events: [],
                        error: error instanceof GaliError ? error.message : String(error && error.message),
                        stats: { total: 0, hidden: 0, declined: 0 },
                    };
                }
            });

            this.snapshot = {
                fetchedAt: new Date().toISOString(),
                range,
                usingReferences: hasReferences(options),
                calendars,
            };
        } catch (error) {
            this.error = error instanceof GaliError ? error.message : String(error && error.message);
        } finally {
            this.loading = false;
            this.publish();
        }
    }

    /* ---------------- availability scan ---------------- */

    /**
     * Fetch the scan window week by week (gali does not paginate
     * ) through the cache, then run the analyses. Kept separate from the
     * display snapshot so scrolling the grid never invalidates a scan.
     */
    async scanAvailability(params = {}, { force = false } = {}) {
        const key = this.#scanKey(params);
        // Only share a running scan with a request that would compute exactly
        // the same thing: a 60-minute find_slots must not be handed the results
        // of a 30-minute scan that happened to be in flight.
        if (this.scanInFlight && !force && this.scanInFlightKey === key) return this.scanInFlight;
        // As with `refresh`, the queue tail is tracked apart from the running
        // scan, and its own key travels with it: a queued 60-minute scan must
        // not be handed back to a later 30-minute request.
        if (this.queuedScan && !force && this.queuedScanKey === key) return this.queuedScan;
        const tail = this.queuedScan || this.scanInFlight;
        if (tail) {
            // `force` means "ignore the fetch cache", not "run a second scan on
            // top of the first": both would write the same progress/result.
            const queued = tail.catch(() => {}).then(() => this.#startScan(params, { force }));
            this.queuedScan = queued;
            this.queuedScanKey = key;
            queued.catch(() => {}).then(() => {
                if (this.queuedScan === queued) {
                    this.queuedScan = null;
                    this.queuedScanKey = null;
                }
            });
            return queued;
        }
        return this.#startScan(params, { force });
    }

    /** Everything a scan result depends on, so two scans only share a run when
     * they would produce the same answer. */
    #scanKey(params = {}) {
        const settings = this.settings;
        return JSON.stringify([
            params.durationMinutes || settings.slotMinutes,
            params.weeks || settings.scanWeeks,
            params.from || todayISO(),
            SCAN_INPUTS.map((name) => settings[name]),
        ]);
    }

    #startScan(params, { force }) {
        const started = this.#runScan(params, { force }).finally(() => {
            if (this.scanInFlight === started) {
                this.scanInFlight = null;
                this.scanInFlightKey = null;
            }
        });
        this.scanInFlight = started;
        this.scanInFlightKey = this.#scanKey(params);
        return started;
    }

    async #runScan(params, { force }) {
        const settings = this.settings;
        const durationMinutes = params.durationMinutes || settings.slotMinutes;
        const weeks = params.weeks || settings.scanWeeks;
        const from = params.from || todayISO();
        const until = addDays(from, weeks * 7 - 1);
        // The settings this run is derived from. If they change while the weeks
        // are being fetched the result describes a different question (a
        // participant added mid-scan was never checked), so it is thrown away.
        const inputs = JSON.stringify(SCAN_INPUTS.map((name) => settings[name]));
        const stale = () => inputs !== JSON.stringify(SCAN_INPUTS.map((name) => this.settings[name]));

        this.scanProgress = { done: 0, total: 0, phase: "starting", cached: 0 };
        this.publish();

        try {
            const chunks = weekChunks(from, until);
            const targets = [];
            for (const entry of settings.calendars) {
                for (const chunk of chunks) targets.push({ entry, chunk });
            }
            if (settings.holidayCalendarId && settings.skipHolidays) {
                for (const chunk of chunks) {
                    targets.push({ entry: { id: settings.holidayCalendarId, label: "祝日" }, chunk, holiday: true });
                }
            }
            this.scanProgress = { done: 0, total: targets.length, phase: "fetching", cached: 0 };
            this.publish();

            const options = { refs: settings.refs, refMyCals: settings.refMyCals, building: settings.building };
            const eventsByCalendar = new Map();
            const errors = new Map();
            const holidayEvents = [];

            await mapWithConcurrency(targets, FETCH_CONCURRENCY, async (target) => {
                try {
                    const result = await fetchWeek(
                        target.entry.id,
                        target.chunk.since,
                        target.chunk.until,
                        target.holiday ? {} : options,
                        { force },
                    );
                    if (target.holiday) holidayEvents.push(...result.events);
                    else {
                        if (!eventsByCalendar.has(target.entry.id)) eventsByCalendar.set(target.entry.id, new Map());
                        const bucket = eventsByCalendar.get(target.entry.id);
                        // Week chunks overlap at boundaries for multi-day events.
                        for (const event of result.events) bucket.set(`${event.id}\u0000${event.start}`, event);
                    }
                    if (result.cached) this.scanProgress.cached += 1;
                } catch (error) {
                    const message = error instanceof GaliError ? error.message : String(error && error.message);
                    // Even one missing week makes "everyone is free then" a
                    // guess, so the failure is kept and fails the whole scan.
                    errors.set(
                        target.holiday ? `祝日カレンダー (${target.entry.id})` : target.entry.id,
                        `${target.chunk.since}〜${target.chunk.until}: ${message}`,
                    );
                } finally {
                    this.scanProgress.done += 1;
                    this.publish();
                }
            });

            if (errors.size) {
                throw new GaliError(
                    `スキャンに必要な予定を取得できませんでした。取得できた範囲だけで「全員空き」とは言えないため中止します。\n${[...errors]
                        .map(([id, message]) => `- ${id}: ${message}`)
                        .join("\n")}`,
                );
            }

            if (stale()) {
                throw new GaliError(
                    "スキャン中に対象カレンダーや条件が変更されたため、この結果は破棄しました。もう一度実行してください。",
                );
            }

            this.scanProgress.phase = "analyzing";
            this.publish();

            const calendars = settings.calendars.map((entry, index) => ({
                id: entry.id,
                label: entry.label || entry.id,
                color: PALETTE[index % PALETTE.length],
                error: null,
                events: [...(eventsByCalendar.get(entry.id) || new Map()).values()],
            }));
            this.scanCalendars = calendars;

            const holidays = holidayDatesFrom(holidayEvents);
            const days = enumerateDays(from, until, { weekdaysOnly: settings.scanWeekdaysOnly });
            const analysisSettings = {
                ...settings,
                participantCount: calendars.filter((calendar) => !calendar.error).length,
                // Scans are about the future, so elapsed start times are
                // dropped — unless the caller deliberately asked for a past
                // window.
                includePast: from < todayISO(),
            };
            const index = buildIndex(calendars, days, analysisSettings);
            const { candidates, totalFreeSlots, scannedSlots, slots } = findSlots(index, days, analysisSettings, {
                durationMinutes,
                holidays,
            });
            const { blockers, nearMiss } = analyzeBlockers(slots, calendars);
            const shared = findSharedMeetings(index, { minAttendees: 2 });

            this.scanIndex = index;
            this.scanDays = days;
            this.scanHolidays = holidays;
            this.scanSettings = analysisSettings;
            this.scan = {
                fetchedAt: new Date().toISOString(),
                from,
                until,
                weeks,
                durationMinutes,
                weekdaysOnly: settings.scanWeekdaysOnly,
                calendars: calendars.map((calendar) => ({
                    id: calendar.id,
                    label: calendar.label,
                    error: calendar.error,
                    events: calendar.events.length,
                })),
                holidays: [...holidays.dates].sort().map((day) => ({ day, label: holidays.labels.get(day) || "" })),
                candidates,
                totalFreeSlots,
                scannedSlots,
                blockers,
                nearMiss: nearMiss.slice(0, 60),
                sharedMeetings: shared.map((group) => ({
                    title: group.title,
                    detailsVisible: group.detailsVisible,
                    attendees: group.attendees,
                    attendeeCount: group.attendeeCount,
                    recurring: group.recurring,
                    kind: group.kind,
                    occurrences: group.occurrences.length,
                    firstStart: group.occurrences[0] ? group.occurrences[0].start : "",
                    durationMinutes: group.occurrences[0] ? group.occurrences[0].durationMinutes : 0,
                    keys: group.keys,
                })),
            };
            pruneCache().catch(() => {});
        } catch (error) {
            this.invalidateScan();
            this.error = error instanceof GaliError ? error.message : String(error && error.message);
        } finally {
            this.scanProgress = null;
            this.publish();
        }
        return this.scan;
    }

    /** What-if for one shared meeting; needs a scan to have run first. */
    whatIf(keys) {
        if (!this.scanIndex) return null;
        return simulateReschedule(this.scanIndex, this.scanDays, this.scanSettings, {
            keys,
            durationMinutes: this.scan.durationMinutes,
            holidays: this.scanHolidays,
        });
    }
}

const profiles = new Map();

export async function getProfileState(profileName, overrides) {
    const profile = normalizeProfile(profileName);
    let state = profiles.get(profile);
    if (!state) {
        state = new ProfileState(profile);
        profiles.set(profile, state);
    }
    if (!state.settings) {
        // Share one load between concurrent first opens: a second, slower
        // load could otherwise land after another caller's overrides were
        // saved and overwrite them with the older disk contents.
        if (!state.settingsLoad) {
            state.settingsLoad = loadSettings(profile).then(
                (loaded) => {
                    if (!state.settings) state.settings = loaded;
                },
                (error) => {
                    state.settingsLoad = null;
                    throw error;
                },
            );
        }
        await state.settingsLoad;
    }
    if (overrides && Object.keys(overrides).length > 0) {
        await state.updateSettings(overrides, { refresh: false });
    }
    return state;
}

export function peekProfileState(profileName) {
    return profiles.get(normalizeProfile(profileName)) || null;
}
