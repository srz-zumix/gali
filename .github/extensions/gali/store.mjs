// Durable settings for the canvas.
//
// The list of colleagues you watch is user data, not repository data, so it is
// stored under $COPILOT_HOME (default ~/.copilot) even though this extension
// itself lives in .github/extensions/ and is committed. Each saved view is keyed
// by a `profile` name — the domain ID — so the same profile opened from two
// panels (or after a reload) shows the same calendars.

import { chmod, mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { DEFAULT_AWAY_RATIO, DEFAULT_POLICY_PATTERNS } from "./classify.mjs";
import { MIN_GRID_HEIGHT } from "./ui/layout.mjs";

const COPILOT_HOME = process.env.COPILOT_HOME || path.join(homedir(), ".copilot");
// Deliberately *outside* $COPILOT_HOME/extensions/gali-calendar: that directory
// is the extension installation, and `gali copilot extension update` replaces it
// wholesale (go-gh-extension moves the old copy aside and deletes it), which
// would take the saved profiles with it.
const ARTIFACT_DIR = path.join(COPILOT_HOME, "gali-calendar", "profiles");
const LEGACY_ARTIFACT_DIR = path.join(COPILOT_HOME, "extensions", "gali-calendar", "artifacts", "profiles");

export const PROFILE_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export const JAPAN_HOLIDAY_CALENDAR = "en.japanese#holiday@group.v.calendar.google.com";

export const DEFAULT_SETTINGS = {
    calendars: [],
    view: "week",
    anchor: "",
    refs: [],
    refMyCals: false,
    building: "",
    showDeclined: false,
    showCompletionDiff: true,
    workStart: "09:00",
    workEnd: "18:00",
    showFreeSlots: true,
    gridHeight: 0,
    // Availability scan.
    slotMinutes: 30,
    scanWeeks: 4,
    scanWeekdaysOnly: true,
    holidayCalendarId: JAPAN_HOLIDAY_CALENDAR,
    skipHolidays: true,
    skipPolicySlots: true,
    policyPatterns: DEFAULT_POLICY_PATTERNS,
    awayRatio: DEFAULT_AWAY_RATIO,
    treatAwayAsBusy: true,
};

export function normalizeProfile(profile) {
    const value = String(profile || "default").trim();
    return PROFILE_PATTERN.test(value) ? value : "default";
}

function profilePath(profile) {
    return path.join(ARTIFACT_DIR, `${normalizeProfile(profile)}.json`);
}

function legacyProfilePath(profile) {
    return path.join(LEGACY_ARTIFACT_DIR, `${normalizeProfile(profile)}.json`);
}

function coerceCalendars(value) {
    if (!Array.isArray(value)) return [];
    const seen = new Set();
    const result = [];
    for (const entry of value) {
        const id = typeof entry === "string" ? entry.trim() : String((entry && entry.id) || "").trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        result.push({
            id,
            label: (entry && typeof entry === "object" && entry.label) || "",
        });
    }
    return result;
}

function coerceStringList(value) {
    if (!Array.isArray(value)) return [];
    return [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))];
}

function coerceTime(value, fallback) {
    return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || "")) ? String(value) : fallback;
}

function coerceInt(value, fallback, min, max) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
}

function coerceRatio(value, fallback) {
    const parsed = Number.parseFloat(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(1, Math.max(0.3, parsed));
}

function bool(value, fallback) {
    return value === undefined ? fallback : Boolean(value);
}

export function sanitizeSettings(raw) {
    const input = raw && typeof raw === "object" ? raw : {};
    const view = ["day", "3days", "week"].includes(input.view) ? input.view : DEFAULT_SETTINGS.view;
    const patterns = coerceStringList(input.policyPatterns);
    const gridHeight = coerceInt(input.gridHeight, DEFAULT_SETTINGS.gridHeight, 0, Number.MAX_SAFE_INTEGER);
    return {
        calendars: coerceCalendars(input.calendars),
        view,
        anchor: /^\d{4}-\d{2}-\d{2}$/.test(String(input.anchor || "")) ? String(input.anchor) : "",
        refs: coerceStringList(input.refs),
        refMyCals: Boolean(input.refMyCals),
        building: String(input.building || "").trim(),
        showDeclined: Boolean(input.showDeclined),
        showCompletionDiff: bool(input.showCompletionDiff, DEFAULT_SETTINGS.showCompletionDiff),
        workStart: coerceTime(input.workStart, DEFAULT_SETTINGS.workStart),
        workEnd: coerceTime(input.workEnd, DEFAULT_SETTINGS.workEnd),
        showFreeSlots: input.showFreeSlots === undefined ? true : Boolean(input.showFreeSlots),
        gridHeight: gridHeight === 0 ? 0 : Math.max(MIN_GRID_HEIGHT, gridHeight),
        slotMinutes: coerceInt(input.slotMinutes, DEFAULT_SETTINGS.slotMinutes, 15, 480),
        scanWeeks: coerceInt(input.scanWeeks, DEFAULT_SETTINGS.scanWeeks, 1, 12),
        scanWeekdaysOnly: bool(input.scanWeekdaysOnly, DEFAULT_SETTINGS.scanWeekdaysOnly),
        holidayCalendarId:
            input.holidayCalendarId === undefined
                ? DEFAULT_SETTINGS.holidayCalendarId
                : String(input.holidayCalendarId || "").trim(),
        skipHolidays: bool(input.skipHolidays, DEFAULT_SETTINGS.skipHolidays),
        skipPolicySlots: bool(input.skipPolicySlots, DEFAULT_SETTINGS.skipPolicySlots),
        policyPatterns: patterns.length ? patterns : [...DEFAULT_SETTINGS.policyPatterns],
        awayRatio: coerceRatio(input.awayRatio, DEFAULT_SETTINGS.awayRatio),
        treatAwayAsBusy: bool(input.treatAwayAsBusy, DEFAULT_SETTINGS.treatAwayAsBusy),
    };
}

export async function loadSettings(profile) {
    for (const file of [profilePath(profile), legacyProfilePath(profile)]) {
        try {
            const text = await readFile(file, "utf8");
            return sanitizeSettings(JSON.parse(text));
        } catch {
            // Fall through to the legacy location, then to the defaults.
        }
    }
    return sanitizeSettings(DEFAULT_SETTINGS);
}

export async function saveSettings(profile, settings) {
    const clean = sanitizeSettings(settings);
    // The watched addresses are personal data: keep the directory and the file
    // private to this user rather than relying on the ambient umask.
    await mkdir(ARTIFACT_DIR, { recursive: true, mode: 0o700 });
    await writeFile(profilePath(profile), `${JSON.stringify(clean, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
    });
    await chmod(profilePath(profile), 0o600).catch(() => {});
    return clean;
}

export async function listProfiles() {
    const names = new Set();
    for (const dir of [ARTIFACT_DIR, LEGACY_ARTIFACT_DIR]) {
        try {
            for (const name of await readdir(dir)) {
                if (name.endsWith(".json")) names.add(name.slice(0, -5));
            }
        } catch {
            // Directory not created yet.
        }
    }
    return [...names];
}

export function settingsFileFor(profile) {
    return profilePath(profile);
}
