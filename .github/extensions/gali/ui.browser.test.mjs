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

test("timed events remain distinct in the browser in normal and sharing modes", {
    skip: !chrome && "Chrome or Chromium is unavailable; set CHROME_BIN to enable the browser test",
    timeout: 60_000,
}, async () => {
    const [index, css, app, layout, meetings] = await Promise.all(
        ["index.html", "app.css", "app.js", "layout.mjs", "meetings.mjs"].map((name) =>
            readFile(new URL(`./ui/${name}`, import.meta.url), "utf8")),
    );
    const script = [
        "window.EventSource = class {}; window.fetch = () => new Promise(() => {});",
        layout.replace(/^export /gm, ""),
        meetings.replace(/^export /gm, ""),
        app.replace(/^import .+ from "\.\/(?:layout|meetings)\.mjs";\r?\n/gm, ""),
        `try { document.body.dataset.geometryResult = encodeURIComponent(JSON.stringify((${checkLayout})())); }
         catch (error) { document.body.dataset.geometryResult = encodeURIComponent(JSON.stringify([String(error.stack || error)])); }`,
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
