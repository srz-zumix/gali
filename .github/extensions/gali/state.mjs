// Per-profile shared state: settings, the last fetched snapshot, and the
// subscribers (SSE clients) that need to know when either changes.
//
// State is keyed by profile — never by canvas instance — so two panels showing
// the same profile stay in sync and a reload rehydrates from disk.

import { randomUUID } from "node:crypto";

import { GaliError, hasReferences } from "./gali.mjs";
import { computeFreeSlots, dayBounds } from "./freebusy.mjs";
import { fetchWeek, mergeEventChunks, pruneCache } from "./cache.mjs";
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
import { presetStore } from "./presets.mjs";
import { findRecurringSlots, RECURRENCES } from "./recurring.mjs";
import { findRecurringSeries } from "./series.mjs";

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

function calendarInputs(calendars) {
    return calendars
        .map(({ id, label }) => [id, label])
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function scanInputs(settings) {
    return SCAN_INPUTS.map((key) => key === "calendars" ? calendarInputs(settings.calendars) : settings[key]);
}

function scanInputsChanged(before, after) {
    if (!before) return false;
    return JSON.stringify(scanInputs(before)) !== JSON.stringify(scanInputs(after));
}

function calendarsInSettingsOrder(calendars, settings) {
    const byId = new Map(calendars.map((calendar) => [calendar.id, calendar]));
    if (byId.size !== settings.calendars.length) throw new Error("カレンダーの並び順を更新できませんでした。");
    return settings.calendars.map(({ id }) => {
        const calendar = byId.get(id);
        if (!calendar) throw new Error("カレンダーの並び順を更新できませんでした。");
        return calendar;
    });
}

export class CalendarOrderError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}

export class RecurringSearchError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}

export function pad2(value) {
    return String(value).padStart(2, "0");
}

export function toISODate(date) {
    return `${String(date.getFullYear()).padStart(4, "0")}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
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
    // Cache chunks are Monday-first, independent of the displayed range.
    const offset = (date.getDay() + 6) % 7;
    date.setDate(date.getDate() - offset);
    return toISODate(date);
}

function weeksForRange(range) {
    const weeks = [];
    // Compare parsed dates, not ISO strings: past year 9999 the string order
    // ("10000-01-03" < "9999-12-31") no longer matches chronological order.
    const end = parseISODate(range.until).getTime();
    for (let since = startOfWeek(range.since); parseISODate(since).getTime() <= end; since = addDays(since, 7)) {
        weeks.push({ since, until: addDays(since, 6) });
    }
    return weeks;
}

function eventInRange(event, range) {
    if (event.allDay) {
        return range.days.some((day) => day >= event.start && (event.end ? day < event.end : day === event.start));
    }
    // Absolute-time overlap, not wall-clock clipping: across a DST rollback an
    // event can end at an earlier wall-clock time than it starts.
    const start = new Date(event.start);
    const end = event.end ? new Date(event.end) : new Date(start.getTime() + 30 * 60_000);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return false;
    return range.days.some((day) => {
        const [dayStart, dayEnd] = dayBounds(day);
        return end > dayStart && start < dayEnd;
    });
}

export function resolveRange(settings) {
    const anchor = settings.anchor || todayISO();
    let length = 1;
    if (settings.view === "week") {
        length = 7;
    } else if (settings.view === "3days") {
        length = 3;
    }
    const days = Array.from({ length }, (_, index) => addDays(anchor, index));
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

export class ProfileState {
    constructor(profile, { fetchCalendarWeek = fetchWeek, prune = pruneCache } = {}) {
        this.profile = profile;
        this.fetchCalendarWeek = fetchCalendarWeek;
        this.pruneCache = prune;
        this.settings = null;
        this.snapshot = null;
        this.error = null;
        this.loading = false;
        this.revision = 0;
        this.listeners = new Set();
        this.inFlight = null;
        this.log = null;
        // Availability scan, independent of the displayed range.
        this.scan = null;
        this.scanProgress = null;
        this.scanInFlight = null;
        this.scanInFlightKey = null;
        this.scanInFlightGeneration = null;
        this.scanGeneration = 0;
        this.scanCalendars = null;
        this.scanSeries = null;
        this.fetchGeneration = 0;
        this.fetchRequestId = 0;
        this.latestFetchRequest = null;
        // Queue tails, kept apart from the active run above.
        this.queuedFetch = null;
        this.queuedScan = null;
        this.queuedScanKey = null;
        this.queuedScanGeneration = null;
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
        this.revision += 1;
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
            revision: this.revision,
            settings: this.settings,
            presets: presetStore.snapshot(),
            presetError: presetStore.error,
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
            const previousFetchKey = this.#fetchKey();
            const resolved = typeof patch === "function" ? patch(this.settings) : patch;
            const next = sanitizeSettings({ ...this.settings, ...resolved });
            this.settings = await saveSettings(this.profile, next);
            if (previousFetchKey !== this.#fetchKey()) {
                this.fetchGeneration += 1;
                this.snapshot = null;
                this.error = null;
                this.loading = false;
            } else {
                if (this.snapshot) {
                    this.snapshot = {
                        ...this.snapshot,
                        calendars: calendarsInSettingsOrder(this.snapshot.calendars, this.settings),
                    };
                }
                if (this.scan?.calendars && !scanInputsChanged(before, this.settings)) {
                    this.scan = {
                        ...this.scan,
                        calendars: calendarsInSettingsOrder(this.scan.calendars, this.settings),
                    };
                }
            }
            // Anything the scan was computed from changed, so the stored scan
            // (and the what-if index built with it) no longer describes these
            // settings. Range navigation is display-only and does not count.
            if (scanInputsChanged(before, this.settings)) this.invalidateScan();
        });
        this.publish();
        if (refresh) await this.refresh();
        return this.settings;
    }

    async moveCalendar(input) {
        const { id, direction, targetId, position } = input || {};
        const directional = ["left", "right"].includes(direction) && targetId === undefined && position === undefined;
        const relative = direction === undefined && typeof targetId === "string" && targetId.trim()
            && ["before", "after"].includes(position);
        if (typeof id !== "string" || !id.trim() || (!directional && !relative)) {
            throw new CalendarOrderError("invalid_calendar_move", "移動するカレンダーと移動先を指定してください。");
        }
        return this.updateSettings((settings) => {
            const calendars = [...settings.calendars];
            const from = calendars.findIndex((entry) => entry.id === id);
            if (from < 0) {
                throw new CalendarOrderError("calendar_not_found", "移動するカレンダーが見つかりません。");
            }
            if (directional) {
                const to = from + (direction === "left" ? -1 : 1);
                if (to < 0 || to >= calendars.length) return {};
                [calendars[from], calendars[to]] = [calendars[to], calendars[from]];
            } else {
                if (!calendars.some((entry) => entry.id === targetId)) {
                    throw new CalendarOrderError("calendar_not_found", "移動先のカレンダーが見つかりません。");
                }
                if (id === targetId) return {};
                const [moving] = calendars.splice(from, 1);
                const target = calendars.findIndex((entry) => entry.id === targetId);
                calendars.splice(target + (position === "after" ? 1 : 0), 0, moving);
            }
            return { calendars };
        }, { refresh: false });
    }

    async createMemberPreset(name) {
        return this.#locked(() => presetStore.create(name, this.settings.calendars));
    }

    async updateMemberPreset(id) {
        return this.#locked(() => presetStore.update(id, this.settings.calendars));
    }

    async applyMemberPreset(id, { waitForRefresh = true } = {}) {
        const preset = await presetStore.get(id);
        await this.updateSettings({ calendars: preset.calendars }, { refresh: false });
        const generation = this.fetchGeneration;
        const refresh = this.refresh();
        if (waitForRefresh) {
            await refresh;
        } else {
            refresh.catch((error) => {
                if (generation === this.fetchGeneration) {
                    this.error = `プリセット適用後の予定取得に失敗しました: ${error.message || error}`;
                    this.publish();
                }
            });
        }
        return preset;
    }

    invalidateScan() {
        this.scanGeneration += 1;
        this.clearScanResults();
    }

    /** Drop the current scan results without invalidating queued scans. */
    clearScanResults() {
        this.scan = null;
        this.scanProgress = null;
        this.scanIndex = null;
        this.scanDays = null;
        this.scanHolidays = null;
        this.scanSettings = null;
        this.scanCalendars = null;
        this.scanSeries = null;
    }

    /** Everything the displayed snapshot depends on. */
    #fetchKey() {
        const settings = this.settings;
        const range = resolveRange(settings);
        return JSON.stringify([
            range.since,
            range.until,
            calendarInputs(settings.calendars),
            settings.refs,
            settings.refMyCals,
            settings.building,
        ]);
    }

    refresh({ force = false } = {}) {
        const key = this.#fetchKey();
        const generation = this.fetchGeneration;
        const latest = this.latestFetchRequest;
        if (!force && latest && latest.key === key && latest.generation === generation) return latest.promise;
        const request = {
            id: ++this.fetchRequestId,
            key,
            generation,
            settings: this.settings,
            range: resolveRange(this.settings),
            force,
        };
        request.promise = this.#refreshRequest(request);
        this.latestFetchRequest = request;
        request.promise.then(
            () => { if (this.latestFetchRequest === request) this.latestFetchRequest = null; },
            () => { if (this.latestFetchRequest === request) this.latestFetchRequest = null; },
        );
        return request.promise;
    }

    #isCurrentFetch(request) {
        return request.id === this.fetchRequestId && request.generation === this.fetchGeneration;
    }

    async #refreshRequest(request) {
        if (!request.force) {
            const cached = await this.#buildSnapshot(request, { cacheOnly: true });
            if (!this.#isCurrentFetch(request)) return null;
            if (cached) {
                this.snapshot = {
                    ...cached,
                    calendars: calendarsInSettingsOrder(cached.calendars, this.settings),
                };
                this.error = null;
                this.loading = false;
                this.publish();
                return this.snapshot;
            }
        }
        if (!this.#isCurrentFetch(request)) return null;
        const tail = this.queuedFetch || this.inFlight;
        if (tail) {
            this.loading = true;
            this.error = null;
            this.publish();
            const queued = tail.catch(() => {}).then(() => (
                this.#isCurrentFetch(request) ? this.#startFetch(request) : null
            ));
            this.queuedFetch = queued;
            queued.then(
                () => { if (this.queuedFetch === queued) this.queuedFetch = null; },
                () => { if (this.queuedFetch === queued) this.queuedFetch = null; },
            );
            return queued;
        }
        return this.#startFetch(request);
    }

    #startFetch(request) {
        const started = this.#fetch(request).finally(() => {
            if (this.inFlight === started) {
                this.inFlight = null;
            }
        });
        this.inFlight = started;
        return started;
    }

    async #buildSnapshot(request, { cacheOnly = false } = {}) {
        const { settings, range } = request;
        const options = { refs: settings.refs, refMyCals: settings.refMyCals, building: settings.building };
        const weeks = weeksForRange(range);
        const calendars = await mapWithConcurrency(settings.calendars, FETCH_CONCURRENCY, async (entry, index) => {
            const base = {
                id: entry.id,
                label: entry.label || entry.id,
                color: PALETTE[index % PALETTE.length],
            };
            try {
                const chunks = [];
                for (const week of weeks) {
                    const result = await this.fetchCalendarWeek(entry.id, week.since, week.until, options, {
                        cacheOnly,
                        force: request.force && !cacheOnly,
                    });
                    if (!result) return null;
                    chunks.push(result);
                }
                const newest = chunks.reduce((a, b) => a.fetchedAt >= b.fetchedAt ? a : b);
                const events = mergeEventChunks(chunks.map((chunk) => ({
                    events: chunk.events,
                    at: Date.parse(chunk.fetchedAt),
                    times: chunk.eventTimes,
                }))).filter((event) => eventInRange(event, range));
                const hidden = events.filter((event) => !event.detailsVisible).length;
                const declined = events.filter((event) => event.responseStatus === "declined").length;
                return {
                    ...base,
                    label: entry.label || newest.summary || entry.id,
                    summary: newest.summary,
                    timeZone: newest.timeZone,
                    accessRole: newest.accessRole,
                    events,
                    error: null,
                    fetchedAt: chunks.map((chunk) => chunk.fetchedAt).sort()[0],
                    cacheHits: chunks.filter((chunk) => chunk.cached).length,
                    cacheChunks: chunks.length,
                    stats: { total: events.length, hidden, declined },
                };
            } catch (error) {
                // A failed cache-only probe falls back to the normal fetch,
                // which reports the underlying failure on the calendar.
                if (cacheOnly) return null;
                return {
                    ...base,
                    summary: entry.id,
                    timeZone: "",
                    accessRole: "",
                    events: [],
                    error: error instanceof GaliError ? error.message : String(error?.message || error),
                    stats: { total: 0, hidden: 0, declined: 0 },
                };
            }
        });
        if (cacheOnly && calendars.some((calendar) => !calendar)) return null;
        const successful = calendars.filter((calendar) => !calendar.error);
        const times = successful.map((calendar) => calendar.fetchedAt).sort();
        return {
            fetchedAt: times[0] || new Date().toISOString(),
            range,
            usingReferences: hasReferences(options),
            cache: {
                hits: successful.reduce((total, calendar) => total + calendar.cacheHits, 0),
                chunks: successful.reduce((total, calendar) => total + calendar.cacheChunks, 0),
            },
            calendars,
        };
    }

    async #fetch(request) {
        if (this.#isCurrentFetch(request)) {
            this.loading = true;
            this.error = null;
            this.publish();
        }
        try {
            const snapshot = await this.#buildSnapshot(request);
            if (this.#isCurrentFetch(request)) {
                this.snapshot = {
                    ...snapshot,
                    calendars: calendarsInSettingsOrder(snapshot.calendars, this.settings),
                };
                this.pruneCache().catch(() => {});
            }
        } catch (error) {
            if (this.#isCurrentFetch(request)) {
                this.error = error instanceof GaliError ? error.message : String(error?.message || error);
            }
        } finally {
            if (this.#isCurrentFetch(request)) {
                this.loading = false;
                this.publish();
            }
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
        const generation = this.scanGeneration;
        // Only share a running scan with a request that would compute exactly
        // the same thing: a 60-minute find_slots must not be handed the results
        // of a 30-minute scan that happened to be in flight.
        if (this.scanInFlight && !force && this.scanInFlightKey === key && this.scanInFlightGeneration === generation) {
            return this.scanInFlight;
        }
        // As with `refresh`, the queue tail is tracked apart from the running
        // scan, and its own key travels with it: a queued 60-minute scan must
        // not be handed back to a later 30-minute request.
        if (this.queuedScan && !force && this.queuedScanKey === key && this.queuedScanGeneration === generation) {
            return this.queuedScan;
        }
        const tail = this.queuedScan || this.scanInFlight;
        if (tail) {
            // `force` means "ignore the fetch cache", not "run a second scan on
            // top of the first": both would write the same progress/result.
            const queued = tail.catch(() => {}).then(() => (
                generation === this.scanGeneration ? this.#startScan(params, { force }) : null
            ));
            this.queuedScan = queued;
            this.queuedScanKey = key;
            this.queuedScanGeneration = generation;
            queued.catch(() => {}).then(() => {
                if (this.queuedScan === queued) {
                    this.queuedScan = null;
                    this.queuedScanKey = null;
                    this.queuedScanGeneration = null;
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
            scanInputs(settings),
        ]);
    }

    #startScan(params, { force }) {
        const generation = this.scanGeneration;
        const started = this.#runScan(params, { force }, generation).finally(() => {
            if (this.scanInFlight === started) {
                this.scanInFlight = null;
                this.scanInFlightKey = null;
                this.scanInFlightGeneration = null;
            }
        });
        this.scanInFlight = started;
        this.scanInFlightKey = this.#scanKey(params);
        this.scanInFlightGeneration = generation;
        return started;
    }

    async #runScan(params, { force }, generation) {
        const settings = this.settings;
        const durationMinutes = params.durationMinutes || settings.slotMinutes;
        const weeks = params.weeks || settings.scanWeeks;
        const from = params.from || todayISO();
        const until = addDays(from, weeks * 7 - 1);
        // The settings this run is derived from. If they change while the weeks
        // are being fetched the result describes a different question (a
        // participant added mid-scan was never checked), so it is thrown away.
        const inputs = JSON.stringify(scanInputs(settings));
        const stale = () =>
            generation !== this.scanGeneration || inputs !== JSON.stringify(scanInputs(this.settings));

        const progress = { done: 0, total: 0, phase: "starting", cached: 0 };
        this.scanProgress = progress;
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
            progress.total = targets.length;
            progress.phase = "fetching";
            this.publish();

            const options = { refs: settings.refs, refMyCals: settings.refMyCals, building: settings.building };
            const eventsByCalendar = new Map();
            const errors = new Map();
            const holidayChunks = [];

            await mapWithConcurrency(targets, FETCH_CONCURRENCY, async (target) => {
                try {
                    const result = await this.fetchCalendarWeek(
                        target.entry.id,
                        target.chunk.since,
                        target.chunk.until,
                        target.holiday ? {} : options,
                        { force },
                    );
                    const chunk = { events: result.events, at: Date.parse(result.fetchedAt), times: result.eventTimes };
                    if (target.holiday) holidayChunks.push(chunk);
                    else {
                        if (!eventsByCalendar.has(target.entry.id)) eventsByCalendar.set(target.entry.id, []);
                        eventsByCalendar.get(target.entry.id).push(chunk);
                    }
                    if (result.cached) progress.cached += 1;
                } catch (error) {
                    const message = error instanceof GaliError ? error.message : String(error && error.message);
                    // Even one missing week makes "everyone is free then" a
                    // guess, so the failure is kept and fails the whole scan.
                    errors.set(
                        target.holiday ? `祝日カレンダー (${target.entry.id})` : target.entry.id,
                        `${target.chunk.since}〜${target.chunk.until}: ${message}`,
                    );
                } finally {
                    progress.done += 1;
                    if (!stale()) this.publish();
                }
            });

            if (errors.size) {
                throw new GaliError(
                    `スキャンに必要な予定を取得できませんでした。取得できた範囲だけで「全員空き」とは言えないため中止します。\n${[...errors]
                        .map(([id, message]) => `- ${id}: ${message}`)
                        .join("\n")}`,
                );
            }

            if (stale()) return null;

            progress.phase = "analyzing";
            this.publish();

            const calendars = settings.calendars.map((entry, index) => ({
                id: entry.id,
                label: entry.label || entry.id,
                color: PALETTE[index % PALETTE.length],
                error: null,
                events: mergeEventChunks(eventsByCalendar.get(entry.id) || []),
            }));
            this.scanCalendars = calendars;

            const holidays = holidayDatesFrom(mergeEventChunks(holidayChunks));
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
            const series = findRecurringSeries(index);

            this.scanIndex = index;
            this.scanDays = days;
            this.scanHolidays = holidays;
            this.scanSettings = analysisSettings;
            this.scanSeries = series;
            this.scan = {
                id: randomUUID(),
                fetchedAt: new Date().toISOString(),
                from,
                until,
                weeks,
                durationMinutes,
                weekdaysOnly: settings.scanWeekdaysOnly,
                calendars: calendarsInSettingsOrder(calendars, this.settings).map((calendar) => ({
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
                recurringMeetings: series.map(({ movableKeys, ...group }) => group),
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
            this.pruneCache().catch(() => {});
        } catch (error) {
            if (!stale()) {
                // Keep the generation: queued scans with current inputs (e.g. a
                // retry or a shorter scan) must still run after this failure.
                this.clearScanResults();
                this.error = error instanceof GaliError ? error.message : String(error && error.message);
            }
        } finally {
            if (this.scanProgress === progress) this.scanProgress = null;
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

    findRecurring({ scanId, recurrence, durationMinutes, seriesIndex } = {}) {
        if (!this.scan || !this.scanIndex || scanId !== this.scan.id) {
            throw new RecurringSearchError("scan_stale", "スキャン結果が変わりました。もう一度候補を探してください。");
        }
        if (!RECURRENCES.includes(recurrence)) {
            throw new RecurringSearchError("invalid_recurrence", "繰り返し周期を選択してください。");
        }
        if (!Number.isInteger(durationMinutes) || durationMinutes < 15 || durationMinutes > 480) {
            throw new RecurringSearchError("invalid_duration", "会議の長さは15〜480分で指定してください。");
        }
        let series = null;
        if (seriesIndex !== undefined && seriesIndex !== null) {
            if (!Number.isInteger(seriesIndex) || seriesIndex < 0 || !this.scanSeries[seriesIndex]) {
                throw new RecurringSearchError("invalid_series", "移動する定期会議を選択してください。");
            }
            series = this.scanSeries[seriesIndex];
            if (!series.identified) {
                throw new RecurringSearchError("unidentified_series", "この定期会議を安全に識別できないため、移動先を計算できません。");
            }
        }
        return {
            scanId: this.scan.id,
            seriesIndex: series ? seriesIndex : null,
            retainedOccurrences: series?.retainedOccurrences || 0,
            ...findRecurringSlots(this.scanIndex, this.scanDays, this.scanSettings, {
                from: this.scan.from,
                until: this.scan.until,
                recurrence,
                durationMinutes,
                holidays: this.scanHolidays,
                excludedKeys: new Set(series?.movableKeys || []),
            }),
        };
    }
}

const profiles = new Map();

presetStore.subscribe(() => {
    for (const state of profiles.values()) {
        if (state.settings) state.publish();
    }
});

export async function getProfileState(profileName, overrides) {
    await presetStore.initialize();
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
