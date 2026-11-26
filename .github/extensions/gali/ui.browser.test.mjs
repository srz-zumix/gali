import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const chrome = process.env.CHROME_BIN || [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, "Google/Chrome/Application/chrome.exe"),
].find((candidate) => candidate && existsSync(candidate));

function checkLayout() {
    const failures = [];
    const check = (condition, message) => { if (!condition) failures.push(message); };
    const day = "2026-10-12";
    const dateTime = (second) => {
        const pad = (value) => String(value).padStart(2, "0");
        const date = second >= 86_400 ? "2026-10-13" : day;
        const time = second % 86_400;
        return `${date}T${pad(Math.floor(time / 3600))}:${pad(Math.floor(time / 60) % 60)}:${pad(time % 60)}`;
    };
    const event = (id, start, end, uid = id) => ({
        id, uid, start: dateTime(start), end: dateTime(end), summary: `Synthetic ${id}`, detailsVisible: true, allDay: false,
    });
    const calendars = ["a", "b", "c", "d"].map((id) => ({
        id, label: id.toUpperCase(), color: "#3f7ee8", events: [],
    }));
    const [left, right] = calendars;
    const addShared = (id, start, end) => {
        left.events.push(event(`${id}-a`, start, end, id));
        right.events.push(event(`${id}-b`, start, end, id));
    };
    left.events.push(event("before", 9 * 3600 + 45 * 60, 10 * 3600));
    addShared("meeting", 10 * 3600, 10 * 3600 + 45 * 60);
    left.events.find((item) => item.id === "meeting-a").responseStatus = "declined";
    addShared("short-join", 18 * 3600, 18 * 3600 + 15 * 60);
    left.events.push(event("after", 18 * 3600 + 15 * 60, 18 * 3600 + 30 * 60));
    left.events.push(event("last", 86_399, 86_400));
    for (let second = 0; second < 100; second += 1) {
        left.events.push(event(`dense-${second}`, 8 * 3600 + second, 8 * 3600 + second + 1));
    }
    addShared("right-edge", 14 * 3600, 14 * 3600 + 1);
    addShared("left-edge", 16 * 3600 + 130, 16 * 3600 + 131);
    for (let second = 0; second < 130; second += 1) {
        right.events.push(event(`right-neighbor-${second}`, 14 * 3600 + second + 1, 14 * 3600 + second + 2));
        left.events.push(event(`left-neighbor-${second}`, 16 * 3600 + second, 16 * 3600 + second + 1));
    }
    const data = {
        settings: { calendars, workStart: "09:00", workEnd: "18:00", showDeclined: true },
        snapshot: { calendars, range: { days: [day] } },
    };

    for (const sharing of [false, true]) {
        data.settings.shareMode = sharing;
        state.data = data;
        state.index = new Map(calendars.flatMap((calendar) =>
            calendar.events.map((item) => [calendarEventKey(calendar.id, item.id), { calendar, event: item }])));
        renderGrid(data);
        const columns = [...document.querySelectorAll("#grid .col")];
        check(columns.length === calendars.length, `missing columns, sharing=${sharing}`);
        const hourLines = columns[0].querySelectorAll(".hline");
        check(hourLines.length === 23
            && Math.abs(hourLines[1].getBoundingClientRect().top - hourLines[0].getBoundingClientRect().top - 54) < 0.02,
            `hour height, sharing=${sharing}`);
        const placements = [];
        for (const [index, column] of columns.entries()) {
            const events = [...calendars[index].events].sort((a, b) =>
                Date.parse(a.start) - Date.parse(b.start) || Date.parse(b.end) - Date.parse(a.end));
            const buttons = [...column.querySelectorAll("button.ev")];
            check(buttons.length === events.length, `missing events, sharing=${sharing}`);
            for (let i = 0; i < Math.min(events.length, buttons.length); i += 1) {
                placements.push({ event: events[i], button: buttons[i], rect: buttons[i].getBoundingClientRect() });
            }
        }
        for (const first of placements) for (const second of placements) {
            if (Date.parse(first.event.end) > Date.parse(second.event.start)) continue;
            const x = Math.min(first.rect.right, second.rect.right) - Math.max(first.rect.left, second.rect.left);
            const y = Math.min(first.rect.bottom, second.rect.bottom) - Math.max(first.rect.top, second.rect.top);
            if (x > 0.001 && y > 0.001) {
                failures.push(`overlap: ${first.event.id}, ${second.event.id}, sharing=${sharing}`);
                break;
            }
        }
        const find = (id) => placements.find((item) => item.event.id === id);
        const before = find("before");
        const meeting = find("meeting-a");
        const peer = find("meeting-b");
        check(before.rect.bottom <= meeting.rect.top, `back-to-back events overlap, sharing=${sharing}`);
        check(meeting.button.classList.contains("join-right") === sharing
            && peer.button.classList.contains("join-left") === sharing, `meeting join, sharing=${sharing}`);
        check(getComputedStyle(meeting.button).textDecorationLine === "line-through", `declined style, sharing=${sharing}`);
        if (sharing) {
            const declined = getComputedStyle(meeting.button);
            check(declined.borderTopStyle === "dotted" && declined.backgroundImage.includes("repeating-linear-gradient"),
                "declined sharing style");
        }
        for (const name of ["left-edge", "right-edge", "short-join"]) {
            const a = find(`${name}-a`);
            const b = find(`${name}-b`);
            check(a.button.classList.contains("join-right") === sharing
                && b.button.classList.contains("join-left") === sharing, `${name} join, sharing=${sharing}`);
            if (sharing) {
                check(Math.abs(a.rect.top - b.rect.top) <= 0.02 && Math.abs(a.rect.bottom - b.rect.bottom) <= 0.02,
                    `${name} joined height`);
            }
        }
        check(find("short-join-a").rect.bottom <= find("after").rect.top, `short join overlap, sharing=${sharing}`);
        const denseWidths = placements.filter((item) => item.event.id.startsWith("dense-")).map((item) => item.rect.width);
        check(denseWidths.length === 100 && denseWidths.every((width) => width > 0 && width < 2), `dense widths, sharing=${sharing}`);
        const microWidths = placements.filter((item) => item.event.id.includes("-neighbor-")).map((item) => item.rect.width);
        check(microWidths.length === 260 && microWidths.every((width) => width > 0 && width < 1), `micro widths, sharing=${sharing}`);
        const last = find("last");
        const columnBottom = columns[0].getBoundingClientRect().bottom;
        last.button.focus();
        const style = getComputedStyle(last.button);
        check(last.rect.height >= 2 && last.rect.bottom <= columnBottom + 0.001,
            `last event visibility, sharing=${sharing}`);
        check(document.activeElement === last.button && Number.parseFloat(style.outlineWidth) >= 1,
            `last event focus, sharing=${sharing}`);
        check(last.button.getAttribute("aria-label").includes("23:59:59"), `last event label, sharing=${sharing}`);
        last.button.click();
        const popover = document.querySelector("#popover");
        check(!popover.hidden && popover.textContent.includes("23:59:59"), `last event details, sharing=${sharing}`);
        check(popover.textContent.includes("Synthetic last") === !sharing, `last event privacy, sharing=${sharing}`);
        if (sharing) {
            check(!document.querySelector("#grid .ev[data-cal], #grid .ev[data-ev]")
                && !document.querySelector("#grid").textContent.includes("Synthetic "), "sharing privacy");
        }
        popover.hidden = true;
    }
    return failures;
}

function checkRecurringUi() {
    const failures = [];
    const check = (condition, message) => { if (!condition) failures.push(message); };
    const data = {
        revision: 1,
        settings: {
            calendars: [], refs: [], policyPatterns: [], workStart: "10:00", workEnd: "19:00",
            slotMinutes: 30, scanWeeks: 4, shareMode: false,
        },
        snapshot: null,
        range: { anchor: "2026-10-12", days: ["2026-10-12"] },
        presets: [],
        freeSlots: [],
        scan: {
            id: "synthetic-scan", fetchedAt: "2026-10-12T00:00:00Z",
            from: "2026-10-12", until: "2026-11-08", durationMinutes: 30,
            candidates: [], blockers: [], nearMiss: [], sharedMeetings: [], calendars: [],
            recurringMeetings: [{
                title: "SECRET_RECURRING", firstStart: "2026-10-12T10:00:00",
                durations: [30], identified: true,
            }],
        },
    };
    apply(data);
    document.getElementById("adjust").hidden = false;
    document.getElementById("move-series").value = "0";
    document.getElementById("move-series").dispatchEvent(new Event("change", { bubbles: true }));
    check(document.getElementById("move-duration").value === "30", "relocation duration");
    state.recurring = {
        scanId: "synthetic-scan",
        seriesIndex: 0,
        result: {
            scanId: "synthetic-scan", seriesIndex: 0, retainedOccurrences: 0,
            from: data.scan.from, until: data.scan.until, recurrence: "weekly", durationMinutes: 30,
            candidates: [
                {
                    pattern: { weekday: 1, anchor: "2026-10-12" }, start: "10:00", end: "10:30",
                    expectedCount: 2, freeCount: 2, busyCount: 0, excludedCount: 0,
                    occurrences: [{ day: "2026-10-12", status: "free" }, { day: "2026-10-19", status: "free" }],
                },
                {
                    pattern: { weekday: 2, anchor: "2026-10-13" }, start: "10:00", end: "10:30",
                    expectedCount: 2, freeCount: 1, busyCount: 1, excludedCount: 0,
                    occurrences: [{ day: "2026-10-13", status: "free" }, { day: "2026-10-20", status: "busy", blockers: ["Alice"] }],
                },
            ],
        },
    };
    renderAdjust(data);
    check(document.querySelectorAll("#tab-candidates .candidate").length === 2, "recurring candidate rows");
    const filter = document.querySelector('[data-recurring-filter="conflicts"]');
    filter.focus();
    filter.click();
    check(document.querySelectorAll("#tab-candidates .candidate").length === 1, "conflict filter");
    check(document.activeElement.matches('[data-recurring-filter="conflicts"]'), "conflict filter focus");
    const detail = document.querySelector("#tab-candidates details");
    detail.open = true;
    check(detail.textContent.includes("2026-10-20") && detail.textContent.includes("予定あり"), "recurring conflict details");
    check(!document.getElementById("move-controls").hidden, "relocation controls");
    const panel = document.getElementById("adjust").getBoundingClientRect();
    check([...document.querySelectorAll("#adjust-tabs button")].every((button) =>
        button.getBoundingClientRect().right <= panel.right + 0.1), "adjust tabs overflow");
    data.revision = 2;
    data.settings.shareMode = true;
    apply(data);
    check(!document.getElementById("tab-candidates").textContent.includes("SECRET_RECURRING")
        && !document.getElementById("move-series").textContent.includes("SECRET_RECURRING"), "recurring sharing privacy");
    return failures;
}

async function checkCandidateOverlays() {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const failures = [];
    const check = (condition, message) => { if (!condition) failures.push(message); };
    const days = ["2026-10-12", "2026-10-13", "2026-10-14"];
    const calendars = ["alice", "bob"].map((id) => ({
        id, label: id, color: "#3f7ee8", error: null,
        stats: { total: id === "alice" ? 1 : 0, hidden: 0, declined: 0 },
        events: id !== "alice" ? [] : [{
            id: "busy", uid: "busy", summary: "SECRET_BUSY", detailsVisible: true, allDay: false,
            start: "2026-10-13T10:15:00", end: "2026-10-13T10:45:00",
        }],
    }));
    const time = (minutes) =>
        `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
    const candidate = (day, start, end) => ({ day, start, end, blockMinutes: 120, reasons: ["SECRET_REASON"] });
    const candidates = [
        ...Array.from({ length: 35 }, (_, index) => candidate(days[0], time(index * 15), time((index + 1) * 15))),
        candidate(days[1], "10:15", "10:45"),
        candidate(days[2], "23:45", "24:00"),
        candidate("2026-10-15", "10:00", "10:30"),
    ];
    const data = {
        profile: "test", revision: 10,
        settings: {
            calendars: calendars.map(({ id, label }) => ({ id, label })), refs: [], policyPatterns: [],
            view: "3days", workStart: "09:00", workEnd: "18:00", slotMinutes: 30, scanWeeks: 4,
            shareMode: false,
        },
        snapshot: { calendars, range: { days }, fetchedAt: "2026-10-12T00:00:00Z" },
        range: { anchor: days[0], days }, presets: [], freeSlots: [],
        scan: {
            id: "overlay-scan", fetchedAt: "2026-10-12T00:00:00Z",
            from: days[0], until: "2026-10-18", durationMinutes: 30, totalFreeSlots: candidates.length,
            candidates, calendars: calendars.map(({ id }) => ({ id, error: null })),
            blockers: [], nearMiss: [], sharedMeetings: [], hint: [],
            recurringMeetings: [{ title: "SECRET_SERIES", firstStart: `${days[0]}T10:15:00`, durations: [30], identified: true }],
        },
    };
    const occurrences = [
        { day: days[0], status: "free" },
        { day: days[1], status: "busy", blockers: ["SECRET_BLOCKER"] },
        { day: days[2], status: "excluded", reason: "SECRET_REASON" },
        { day: "2026-10-15", status: "free" },
    ];
    const recurring = {
        scanId: data.scan.id, seriesIndex: 0, retainedOccurrences: 0,
        from: data.scan.from, until: data.scan.until, recurrence: "weekly", durationMinutes: 30,
        candidates: [
            {
                pattern: { weekday: 1, anchor: days[0] }, start: "10:15", end: "10:45",
                expectedCount: 4, freeCount: 2, busyCount: 1, excludedCount: 1, occurrences,
            },
            {
                pattern: { weekday: 1, anchor: days[0] }, start: "15:00", end: "15:30",
                expectedCount: 1, freeCount: 1, busyCount: 0, excludedCount: 0,
                occurrences: [{ day: days[0], status: "free" }],
            },
        ],
    };
    let revision = data.revision;
    const next = (changes = {}) => ({ ...data, revision: ++revision, ...changes });
    const slots = () => [...document.querySelectorAll("#grid .candidate-slot")];
    const highlighted = () => [...document.querySelectorAll("#grid .candidate-slot.peer-highlight")];
    const layer = (day) => document.querySelector(`#grid .candidate-layer[data-day="${day}"]`);
    const note = () => document.getElementById("candidate-grid-note").textContent;
    state.shareLatched = false;
    state.shareFailure = null;
    state.activeScanRequest = null;
    state.data = null;
    document.getElementById("adjust").hidden = true;
    apply(data);
    let table = document.querySelector("#grid .cal");
    check(slots().length === 0, "closed adjustment panel shows no candidate overlays");
    const event = document.querySelector('#grid .ev[data-cal="alice"][data-ev="busy"]');
    event.focus();
    document.getElementById("toggle-adjust").click();
    check(document.activeElement === event && document.querySelector("#grid .cal") === table, "opening panel preserves grid and event focus");
    check(slots().length === 74, "all visible one-off candidates are shown in each member column");
    check(layer(days[0]).querySelectorAll(".candidate-slot").length === 35, "more than 30 one-off candidates shown");
    check(!layer("2026-10-15"), "out-of-range day omitted");
    const first = layer(days[0]).querySelector(".candidate-slot").getBoundingClientRect();
    const column = layer(days[0]).closest(".col").getBoundingClientRect();
    check(Math.abs(first.top - column.top) < 0.02 && Math.abs(first.height - 13.5) < 0.02, "15-minute candidate geometry");
    const last = layer(days[2]).querySelector(".candidate-slot").getBoundingClientRect();
    const lastColumn = layer(days[2]).closest(".col").getBoundingClientRect();
    check(Math.abs(last.bottom - lastColumn.bottom) < 1.1 && Math.abs(last.height - 13.5) < 0.02, "24:00 candidate geometry");

    let firstRow = document.querySelector('[data-candidate-key="single-0"].candidate');
    let secondRow = document.querySelector('[data-candidate-key="single-1"].candidate');
    check(firstRow.tabIndex === 0, "single candidates are reachable by keyboard");
    firstRow.focus();
    check(highlighted().length === 2 && highlighted().every((slot) => slot.dataset.candidateKey === "single-0"),
        "focusing a candidate outlines only its member columns");
    const [leftFocus, rightFocus] = highlighted().map((slot) => slot.getBoundingClientRect());
    check(leftFocus && rightFocus && Math.abs(leftFocus.right - rightFocus.left) < 3
        && getComputedStyle(highlighted()[0]).boxShadow !== "none", "focused member columns form a visible continuous outline");
    renderAdjust(data);
    firstRow = document.querySelector('[data-candidate-key="single-0"].candidate');
    secondRow = document.querySelector('[data-candidate-key="single-1"].candidate');
    check(document.activeElement === firstRow && highlighted().length === 2 && document.querySelector("#grid .cal") === table,
        "ordinary updates retain candidate focus without replacing the grid");
    secondRow.focus();
    check(highlighted().length === 2 && highlighted().every((slot) => slot.dataset.candidateKey === "single-1"),
        "keyboard navigation changes the outlined candidate");

    const firstSlot = layer(days[0]).querySelector('[data-candidate-key="single-0"]');
    firstSlot.scrollIntoView({ block: "center", inline: "center" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const firstBounds = firstSlot.getBoundingClientRect();
    const x = (firstBounds.left + firstBounds.right) / 2;
    const y = (firstBounds.top + firstBounds.bottom) / 2;
    const gridHit = document.elementFromPoint(x, y);
    gridHit?.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: x, clientY: y }));
    check(highlighted().length === 2 && highlighted().every((slot) => slot.dataset.candidateKey === "single-0"),
        "hovering a calendar candidate outlines the same candidate");
    apply(next());
    await new Promise((resolve) => setTimeout(resolve, 0));
    table = document.querySelector("#grid .cal");
    check(document.activeElement?.dataset.candidateKey === "single-1"
        && highlighted().length === 2 && highlighted().every((slot) => slot.dataset.candidateKey === "single-0"),
        "same-scan updates preserve grid hover over restored keyboard focus");
    document.getElementById("grid").dispatchEvent(new PointerEvent("pointerleave"));
    check(highlighted().length === 2 && highlighted().every((slot) => slot.dataset.candidateKey === "single-1"),
        "pointer exit restores keyboard focus highlighting");
    document.elementFromPoint(x, y)?.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: x, clientY: y }));
    apply(next({ snapshot: { ...data.snapshot, range: { days: [days[1]] } }, range: { anchor: days[1], days: [days[1]] } }));
    check(!state.hoveredCandidate && highlighted().length === 0, "changing range clears a grid hover whose candidate moved away");
    apply(next());
    table = document.querySelector("#grid .cal");
    firstRow = document.querySelector('[data-candidate-key="single-0"].candidate');
    firstRow.scrollIntoView({ block: "nearest" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    let firstLabel = firstRow.querySelector(".candidate-when");
    const labelBounds = firstLabel.getBoundingClientRect();
    const labelX = (labelBounds.left + labelBounds.right) / 2;
    const labelY = (labelBounds.top + labelBounds.bottom) / 2;
    const listHit = document.elementFromPoint(labelX, labelY);
    check(firstRow.contains(listHit), "list candidate is visible for hover");
    listHit?.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, clientX: labelX, clientY: labelY }));
    check(highlighted().length === 2 && highlighted().every((slot) => slot.dataset.candidateKey === "single-0"),
        "list hover outlines its candidate");
    apply(next());
    await new Promise((resolve) => setTimeout(resolve, 0));
    table = document.querySelector("#grid .cal");
    firstRow = document.querySelector('[data-candidate-key="single-0"].candidate');
    firstLabel = firstRow.querySelector(".candidate-when");
    check(document.activeElement?.dataset.candidateKey === "single-1"
        && highlighted().length === 2 && highlighted().every((slot) => slot.dataset.candidateKey === "single-0"),
        "same-scan updates preserve list hover over restored keyboard focus");
    const listViewport = document.querySelector(".adjust-body");
    listViewport.scrollTop += 250;
    listViewport.dispatchEvent(new Event("scroll"));
    const itemUnderPointer = candidateListItem(document.elementFromPoint(labelX, labelY));
    const expectedAfterScroll = itemUnderPointer?.dataset.candidateKey || "single-1";
    check(expectedAfterScroll !== "single-0" && highlighted().length === 2
        && highlighted().every((slot) => slot.dataset.candidateKey === expectedAfterScroll),
        "scrolling re-evaluates the candidate under the pointer");
    listViewport.scrollTop = 0;
    firstRow.scrollIntoView({ block: "nearest" });
    firstLabel.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, clientX: labelX, clientY: labelY }));
    firstLabel.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, relatedTarget: firstRow.querySelector(".reasons") }));
    check(highlighted().length === 2 && highlighted().every((slot) => slot.dataset.candidateKey === "single-0"),
        "moving within a row keeps its outline");
    firstLabel.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, relatedTarget: document.getElementById("scan-btn") }));
    check(highlighted().length === 2 && highlighted().every((slot) => slot.dataset.candidateKey === "single-1"),
        "leaving a row restores focused candidate");
    document.getElementById("scan-btn").focus();
    check(highlighted().length === 0, "leaving a candidate clears the outline");

    check(document.querySelectorAll("#tab-candidates .candidate").length === 30, "one-off list starts with 30");
    const more = document.querySelector("[data-single-more]");
    more.focus();
    more.click();
    check(document.querySelectorAll("#tab-candidates .candidate").length === candidates.length, "all one-off candidates accessible in list");
    check(document.activeElement === document.querySelectorAll("#tab-candidates .candidate")[30], "focus reaches newly shown candidate");
    check(highlighted().length === 2 && highlighted().every((slot) => slot.dataset.candidateKey === "single-30"),
        "newly revealed candidate receives the matching outline");
    check(document.querySelector("#grid .cal") === table, "expanding list does not rebuild grid");
    document.getElementById("toggle-adjust").click();
    check(slots().length === 0 && document.querySelector("#grid .cal") === table, "closing panel removes overlays without rebuilding grid");
    document.getElementById("toggle-adjust").click();
    check(slots().length === 74, "reopening panel restores one-off overlays");

    const selectedSlots = () => [...document.querySelectorAll("#grid .candidate-slot.selected")];
    const row = (key) => document.querySelector(`#tab-candidates .candidate[data-candidate-key="${key}"]`);
    state.singleVisible = 30;
    renderCandidates(data.scan);
    renderCandidateGridNote(data);
    check(layer(days[0]).querySelector('[data-candidate-key="single-2"]').textContent === "候補3",
        "calendar candidates show their list number");
    row("single-1").querySelector(".candidate-when").click();
    check(row("single-1").classList.contains("selected") && row("single-1").getAttribute("aria-current") === "true"
        && selectedSlots().length === 2 && selectedSlots().every((slot) => slot.dataset.candidateKey === "single-1"),
        "clicking a list candidate selects it and its calendar slots");
    check(getComputedStyle(selectedSlots()[0]).boxShadow !== "none", "selected slots are outlined");
    apply(next());
    check(row("single-1").classList.contains("selected") && selectedSlots().length === 2, "same-scan updates keep the selection");
    row("single-1").click();
    check(!row("single-1").classList.contains("selected") && selectedSlots().length === 0, "clicking again clears the selection");
    row("single-2").focus();
    row("single-2").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    check(document.activeElement === row("single-2") && row("single-2").classList.contains("selected"),
        "Enter selects the focused candidate and keeps focus");
    document.getElementById("scan-btn").focus();
    const farSlot = layer(days[0]).querySelector('[data-candidate-key="single-34"]');
    farSlot.scrollIntoView({ block: "center", inline: "center" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const farRect = farSlot.getBoundingClientRect();
    const farX = (farRect.left + farRect.right) / 2;
    const farY = (farRect.top + farRect.bottom) / 2;
    selectTab("blockers");
    document.elementFromPoint(farX, farY)?.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: farX, clientY: farY }));
    const farRow = row("single-34");
    const viewport = document.querySelector(".adjust-body").getBoundingClientRect();
    const farRowRect = farRow?.getBoundingClientRect();
    check(farRow?.classList.contains("selected") && !document.getElementById("tab-candidates").hidden
        && farRowRect.top >= viewport.top - 1 && farRowRect.bottom <= viewport.bottom + 1
        && selectedSlots().every((slot) => slot.dataset.candidateKey === "single-34"),
        "clicking a calendar candidate selects, reveals and scrolls to its list row");
    document.querySelector(".adjust-body").scrollTop = 0;
    const nearSlot = layer(days[0]).querySelector('[data-candidate-key="single-20"]');
    nearSlot.scrollIntoView({ block: "center", inline: "center" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const nearRect = nearSlot.getBoundingClientRect();
    const nearX = (nearRect.left + nearRect.right) / 2;
    const nearY = (nearRect.top + nearRect.bottom) / 2;
    document.elementFromPoint(nearX, nearY)?.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: nearX, clientY: nearY }));
    const linked = [...document.querySelectorAll("#tab-candidates .candidate.peer-highlight")];
    const linkedRect = row("single-20").getBoundingClientRect();
    check(linked.length === 1 && linked[0] === row("single-20")
        && linkedRect.top >= viewport.top - 1 && linkedRect.bottom <= viewport.bottom + 1,
        "hovering a calendar candidate marks and scrolls to its list row");
    document.getElementById("grid").dispatchEvent(new PointerEvent("pointerleave"));
    check(!document.querySelector("#tab-candidates .candidate.peer-highlight"), "leaving the calendar clears the list mark");
    state.selectedCandidate = null;
    selectTab("candidates");
    renderCandidates(data.scan);
    updateCandidateDisplay();
    table = document.querySelector("#grid .cal");

    let resolveRecurring;
    window.fetch = () => new Promise((resolve) => { resolveRecurring = resolve; });
    const pending = requestRecurring({ recurrence: "weekly", durationMinutes: 30, seriesIndex: 0 });
    check(slots().length === 0 && note().includes("計算中"), "recurring computation hides one-off overlays");
    resolveRecurring({ ok: true, json: async () => ({ recurring }) });
    await pending;
    check(slots().length === 0 && note().includes("一覧で"), "recurring result waits for selection");
    let select = document.querySelector('[data-recurring-select="0"]');
    select.focus();
    select.click();
    select = document.querySelector('[data-recurring-select="0"]');
    check(document.activeElement === select && select.getAttribute("aria-pressed") === "true", "recurring selection retains keyboard focus and state");
    check(document.querySelector("#grid .cal") === table, "selecting candidate does not rebuild grid");
    check(slots().length === 6 && layer(days[0]).querySelector(".free")
        && layer(days[1]).querySelector(".busy") && layer(days[2]).querySelector(".excluded"), "selected occurrences use group statuses");
    check(highlighted().length === 6 && highlighted().every((slot) => slot.dataset.candidateKey === "recurring-0"),
        "focused recurring selection outlines all its visible occurrences");
    check(getComputedStyle(layer(days[1]).querySelector(".busy")).borderTopStyle === "dotted"
        && getComputedStyle(layer(days[2]).querySelector(".excluded")).backgroundImage.includes("repeating-linear-gradient"), "status patterns distinguish conflicts and exclusions");
    check(note().includes("誰か1人以上") && note().includes("仮に除外") && note().includes("取得時刻"), "group, hypothetical and scan-time explanations");
    check(!document.querySelector("#grid").innerHTML.includes("SECRET_BLOCKER"), "overlays exclude blocker identities");

    select.click();
    check(slots().length === 0 && document.querySelector('[data-recurring-select="0"]').getAttribute("aria-pressed") === "false",
        "selecting the same candidate again clears its overlay");
    const recurringRow = document.querySelector('#tab-candidates .candidate[data-candidate-key="recurring-0"]');
    recurringRow.querySelector(".candidate-when").click();
    check(slots().length === 6 && selectedSlots().length === 6
        && document.querySelector('#tab-candidates .candidate[data-candidate-key="recurring-0"]').classList.contains("selected"),
        "clicking a recurring row selects it like its button");
    document.querySelector('#tab-candidates .candidate[data-candidate-key="recurring-0"] .candidate-when').click();
    check(slots().length === 0, "clicking the recurring row again clears it");
    select = document.querySelector('[data-recurring-select="0"]');
    select.focus();
    select.click();
    apply(next());
    select = document.querySelector('[data-recurring-select="0"]');
    check(document.activeElement === select && select.getAttribute("aria-pressed") === "true"
        && slots().length === 6 && highlighted().length === 6,
        "same-scan updates preserve recurring selection and focus");
    const summary = select.closest(".candidate").querySelector("summary");
    summary.focus();
    renderAdjust(data);
    check(document.activeElement?.tagName === "SUMMARY" && highlighted().length === 6,
        "recurring occurrence details retain their candidate focus on updates");
    const otherSelect = document.querySelector('[data-recurring-select="1"]');
    otherSelect.focus();
    check(slots().length === 6 && highlighted().length === 0, "unselected recurring candidate is not previewed on focus");
    otherSelect.click();
    check(slots().length === 2 && layer(days[0]).querySelector(".free")
        && !layer(days[1]).querySelector(".candidate-slot") && highlighted().length === 2,
        "only the newly selected recurring candidate remains and is outlined");
    document.querySelector('[data-recurring-select="0"]').click();
    const filter = document.querySelector('[data-recurring-filter="conflicts"]');
    filter.focus();
    filter.click();
    check(slots().length === 0 && document.activeElement.matches('[data-recurring-filter="conflicts"]'), "changing filter clears selection and preserves focus");
    document.querySelector('[data-recurring-select="0"]').click();
    check(slots().length === 6, "filtered selection still uses the original candidate");

    data.settings.shareMode = true;
    document.querySelector('[data-recurring-select="0"]').focus();
    apply(next());
    check(slots().length === 6 && highlighted().length === 6 && !document.querySelector("#grid").innerHTML.includes("SECRET_")
        && !document.querySelector("#tab-candidates").textContent.includes("SECRET_SERIES")
        && !document.querySelector("#tab-candidates").textContent.includes("SECRET_REASON"), "sharing mode keeps overlays anonymous");
    const sharingEvent = document.querySelector('#grid .ev[data-share-time="10:15–10:45"]');
    sharingEvent.focus();
    check(highlighted().length === 0, "focusing an existing event clears candidate focus");
    const otherMember = document.querySelectorAll(`#grid .candidate-layer[data-day="${days[1]}"]`)[1].querySelector(".busy");
    otherMember.scrollIntoView({ block: "center", inline: "center" });
    const otherRect = otherMember.getBoundingClientRect();
    const otherX = (otherRect.left + otherRect.right) / 2;
    const otherY = (otherRect.top + otherRect.bottom) / 2;
    document.elementFromPoint(otherX, otherY)?.dispatchEvent(new PointerEvent("pointermove", {
        bubbles: true, clientX: otherX, clientY: otherY,
    }));
    check(highlighted().length === 6, "hovering an empty member column highlights busy occurrences");
    sharingEvent.scrollIntoView({ block: "center", inline: "center" });
    const eventRect = sharingEvent.getBoundingClientRect();
    const eventX = (eventRect.left + eventRect.right) / 2;
    const eventY = (eventRect.top + eventRect.bottom) / 2;
    const hit = document.elementFromPoint(eventX, eventY);
    check(hit === sharingEvent || sharingEvent.contains(hit), "candidate overlay is pointer-transparent over an event");
    hit?.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: eventX, clientY: eventY }));
    check(highlighted().length === 0, "existing event hover takes precedence over a candidate overlay");
    hit?.click();
    check(!document.getElementById("popover").hidden && !document.getElementById("popover").textContent.includes("SECRET_"),
        "underlying event opens anonymous details");

    apply(next({ loading: true }));
    check(slots().length === 0, "loading hides overlays");
    apply(next({ error: "SECRET_FETCH_ERROR" }));
    check(slots().length === 0 && note().includes("確認できない"), "fetch failure hides overlays");
    apply(next({ snapshot: {
        ...data.snapshot,
        calendars: data.snapshot.calendars.map((calendar) => calendar.id === "bob" ? { ...calendar, error: "failed" } : calendar),
    } }));
    check(slots().length === 0, "member calendar errors hide overlays");
    apply(next({ settings: { ...data.settings, calendars: data.settings.calendars.slice(0, 1) } }));
    check(slots().length === 0, "participant mismatch hides overlays");
    apply(next({ scanProgress: { phase: "starting", done: 0, total: 1 } }));
    check(slots().length === 0, "external scan hides overlays");
    apply(next());
    check(slots().length === 6, "valid same-scan data restores selection");

    const header = document.querySelector('#grid th[data-order-calendar="alice"]');
    header.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: new DataTransfer() }));
    const draggedTable = document.querySelector("#grid .cal");
    const changedDays = [days[1]];
    apply(next({ snapshot: { ...data.snapshot, range: { days: changedDays } }, range: { anchor: days[1], days: changedDays } }));
    check(document.querySelector("#grid .cal") === draggedTable && slots().length === 0 && note().includes("並び替え中"),
        "snapshot changes during a drag clear stale overlays without replacing the grid");
    header.dispatchEvent(new DragEvent("dragend", { bubbles: true }));
    check(document.querySelector("#grid .cal") !== draggedTable && slots().length === 2
        && layer(days[1]).querySelector(".busy"), "ending a drag projects onto the newest snapshot");
    apply(next());

    window.fetch = async () => ({ ok: false, json: async () => ({ error: "SECRET_RECURRING_ERROR" }) });
    await requestRecurring({ recurrence: "weekly", durationMinutes: 30, seriesIndex: 0 });
    check(slots().length === 0 && note().includes("表示できません")
        && !document.querySelector("#tab-candidates").textContent.includes("SECRET_"),
        "failed recurring computation hides overlays and redacts its error");

    const pendingRequests = [];
    window.fetch = () => new Promise((resolve) => pendingRequests.push(resolve));
    const oldRequest = requestRecurring({ recurrence: "weekly", durationMinutes: 30, seriesIndex: 0 });
    const newRequest = requestRecurring({ recurrence: "weekly", durationMinutes: 30, seriesIndex: 0 });
    pendingRequests[1]({ ok: true, json: async () => ({ recurring: { ...recurring, candidates: [recurring.candidates[1]] } }) });
    await newRequest;
    document.querySelector('[data-recurring-select="0"]').click();
    check(slots().length === 2, "newest recurring request can be selected");
    pendingRequests[0]({ ok: true, json: async () => ({ recurring }) });
    await oldRequest;
    check(slots().length === 2 && document.querySelector('[data-recurring-select="0"]').getAttribute("aria-pressed") === "true",
        "older recurring response cannot replace newer selection");

    let resolveScan;
    window.fetch = () => new Promise((resolve) => { resolveScan = resolve; });
    document.getElementById("scan-recurrence").value = "once";
    const pendingScan = runScan(false);
    check(slots().length === 0 && note().includes("探索中") && document.getElementById("scan-btn").disabled,
        "local scan immediately hides overlays");
    resolveScan({ ok: false, json: async () => ({ error: "SECRET_SCAN_ERROR" }) });
    await pendingScan;
    check(slots().length === 0 && note().includes("失敗") && !document.getElementById("scan-error").textContent.includes("SECRET_"),
        "failed scans keep overlays hidden without exposing details in sharing mode");
    apply(next({ scan: { ...data.scan, id: "new-overlay-scan" } }));
    check(slots().length === 74 && highlighted().length === 0 && document.getElementById("scan-error").hidden,
        "new scan clears old scan failure and candidate interaction");

    apply(next({
        settings: { ...data.settings, calendars: data.settings.calendars.slice(0, 1) },
        snapshot: { ...data.snapshot, calendars: data.snapshot.calendars.slice(0, 1) },
        scan: { ...data.scan, id: "single-member-scan", calendars: data.scan.calendars.slice(0, 1) },
    }));
    document.querySelector('[data-candidate-key="single-0"].candidate').focus();
    const singleHighlight = highlighted();
    check(singleHighlight.length === 1 && singleHighlight[0].closest(".candidate-layer").matches(".group-start.group-end")
        && getComputedStyle(singleHighlight[0]).boxShadow !== "none", "a single member receives a complete candidate outline");
    return failures;
}

async function checkMembersUi() {
    const failures = [];
    const check = (condition, message) => { if (!condition) failures.push(message); };
    const data = {
        revision: 3,
        settings: { calendars: [], refs: [], policyPatterns: [], workStart: "09:00", workEnd: "18:00" },
        snapshot: null, range: { days: ["2026-10-12"] }, presets: [], freeSlots: [],
    };
    state.shareLatched = false;
    state.data = null;
    apply(data);
    const actions = document.getElementById("member-actions");
    check(getComputedStyle(actions).display === "none", "member confirmation initially hidden");
    const calls = [];
    window.fetch = async (url, options) => {
        const body = JSON.parse(options.body);
        calls.push({ url, body });
        return { ok: true, json: async () => ({ ...data, revision: 4, settings: { ...data.settings, ...body.settings } }) };
    };
    document.getElementById("settings").hidden = false;
    document.getElementById("add-input").value = "alice bob";
    document.getElementById("add-btn").click();
    await state.orderQueue;
    check(calls.length === 0, "member addition must not fetch");
    check(getComputedStyle(actions).display !== "none", "member confirmation controls visible");
    check(document.querySelectorAll("#chips [data-remove]").length === 2, "staged members displayed");
    document.querySelector('#chips [data-remove="bob"]').click();
    await state.orderQueue;
    check(calls.length === 0, "member removal must not fetch");
    document.getElementById("confirm-members").click();
    await state.orderQueue;
    check(calls.length === 1 && calls[0].url.startsWith("/api/settings"), "confirm makes one request");
    check(calls[0]?.body.settings.calendars.map((entry) => entry.id).join() === "alice", "confirm sends final members only");
    check(getComputedStyle(actions).display === "none", "member confirmation hidden after saving");
    return failures;
}

test("event layout, recurring and member controls work in the browser in normal and sharing modes", {
    skip: !chrome && "Chrome or Chromium is unavailable; set CHROME_BIN to enable the browser test",
    timeout: 60_000,
}, async () => {
    const [index, css, app, layout, meetings, auth] = await Promise.all(
        ["index.html", "app.css", "app.js", "layout.mjs", "meetings.mjs", "auth.mjs"].map((name) =>
            readFile(new URL(`./ui/${name}`, import.meta.url), "utf8")),
    );
    const script = [
        "window.EventSource = class {}; window.fetch = () => new Promise(() => {});",
        layout.replace(/^export /gm, ""),
        meetings.replace(/^export /gm, ""),
        auth.replace(/^export /gm, ""),
        app.replace(/^import .+ from "\.\/(?:layout|meetings|auth)\.mjs";\r?\n/gm, ""),
        `(async () => {
            try { document.body.dataset.geometryResult = encodeURIComponent(JSON.stringify([...(${checkLayout})(), ...(${checkRecurringUi})(), ...await (${checkCandidateOverlays})(), ...await (${checkMembersUi})()])); }
            catch (error) { document.body.dataset.geometryResult = encodeURIComponent(JSON.stringify([String(error.stack || error)])); }
        })();`,
    ].join("\n");
    const html = index.replace('<link rel="stylesheet" href="/app.css" />', `<style>${css}\n#grid { width: 330px; }</style>`)
        .replace('<script src="/app.js" type="module"></script>', `<script>${script}</script>`);
    const directory = await mkdtemp(path.join(tmpdir(), "gali-layout-test-"));
    try {
        const page = path.join(directory, "fixture.html");
        await writeFile(page, html);
        for (const dpr of [1, 1.25, 2]) {
            const { stdout } = await execFileAsync(chrome, [
                "--headless", "--disable-gpu", "--disable-extensions", "--no-first-run", "--no-default-browser-check",
                "--virtual-time-budget=1000",
                `--user-data-dir=${path.join(directory, `profile-${dpr}`)}`, `--force-device-scale-factor=${dpr}`,
                "--window-size=330,800", "--dump-dom", pathToFileURL(page).href,
            ], { maxBuffer: 8 * 1024 * 1024, timeout: 20_000 });
            const result = /data-geometry-result="([^"]+)"/.exec(stdout);
            assert.ok(result, `browser fixture did not report a result at DPR ${dpr}`);
            assert.deepEqual(JSON.parse(decodeURIComponent(result[1])), [], `browser layout at DPR ${dpr}`);
        }
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
