import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createContext, Script } from "node:vm";

import * as layout from "./ui/layout.mjs";
import * as meetings from "./ui/meetings.mjs";

const source = await readFile(new URL("./ui/app.js", import.meta.url), "utf8");
const script = new Script(source.replace(/^import .+ from "\.\/(?:layout|meetings)\.mjs";\r?\n/gm, ""), {
    filename: "ui/app.js",
});

function createRenderer({ now } = {}) {
    const elements = new Map();
    const listeners = new Map();
    const blocks = [];
    const ClockDate = now === undefined ? Date : class extends Date {
        constructor(...args) {
            super(...(args.length ? args : [now]));
        }
        static now() { return now; }
    };
    const context = createContext({
        ...layout,
        ...meetings,
        Date: ClockDate,
        document: {
            querySelectorAll() { return []; },
            addEventListener(type, handler) {
                if (!listeners.has(type)) listeners.set(type, []);
                listeners.get(type).push(handler);
            },
            getElementById(id) {
                if (!elements.has(id)) {
                    elements.set(id, {
                        id,
                        innerHTML: "",
                        textContent: "",
                        value: "",
                        hidden: false,
                        disabled: false,
                        clientHeight: 600,
                        offsetHeight: 10,
                        dataset: {},
                        style: {},
                        attributes: {},
                        handlers: new Map(),
                        addEventListener(type, handler) {
                            if (!this.handlers.has(type)) this.handlers.set(type, []);
                            this.handlers.get(type).push(handler);
                        },
                        setAttribute(name, value) { this.attributes[name] = String(value); },
                        getAttribute(name) { return this.attributes[name] ?? null; },
                        focus() { context.document.activeElement = this; },
                        showModal() { this.open = true; },
                        close() {
                            if (!this.open) return;
                            this.open = false;
                            for (const handler of this.handlers.get("close") || []) handler({ currentTarget: this });
                        },
                        contains(element) {
                            return id === "date-calendar" && Boolean(
                                element?.dataset?.pickerDate || element?.id?.startsWith("date-calendar-"),
                            );
                        },
                        querySelector(selector) {
                            const match = id === "date-calendar-days" && /^\[data-picker-date="([^"]+)"\]$/.exec(selector);
                            if (!match || !this.innerHTML.includes(`data-picker-date="${match[1]}"`)) return null;
                            return {
                                dataset: { pickerDate: match[1] },
                                focus() { context.document.activeElement = this; },
                                closest(value) { return value === "button[data-picker-date]" ? this : null; },
                            };
                        },
                        querySelectorAll() { return blocks.filter((block) => block.dataset.shared); },
                        getBoundingClientRect() { return { width: 200, height: 100 }; },
                    });
                }
                return elements.get(id);
            },
        },
        window: { innerWidth: 1000, innerHeight: 1000, addEventListener() {} },
        ResizeObserver: class { observe() {} },
        EventSource: class {},
        setTimeout,
        URLSearchParams,
        location: { search: "?token=test-token" },
        fetch: () => new Promise(() => {}),
    });
    script.runInContext(context);
    return {
        render(data) {
            context.renderGrid(data);
            return elements.get("grid").innerHTML;
        },
        timedEdges(placements, edge) {
            const connectable = context.connectableTimed(placements)[edge];
            return placements.map((placement) => connectable.has(placement));
        },
        renderStatus(data) {
            context.renderStatus(data);
            return elements.get("status");
        },
        renderChips(data) {
            context.renderChips(data);
            return elements.get("chips").innerHTML;
        },
        apply(data) {
            context.apply(data);
        },
        data() {
            return new Script("state.data").runInContext(context);
        },
        eventMarkup(event, calendar, settings) {
            if (event.allDay) return context.renderAllDay(event, calendar, settings);
            return context.renderEventBlock({
                event, startMin: 540, endMin: 600, lane: 0, laneCount: 1,
            }, calendar, layout.computeGeometry(settings), settings);
        },
        details(event, calendar) {
            context.entry = { event, calendar };
            new Script("state.index.set(entry.calendar.id + '\\u0000' + entry.event.id, entry);").runInContext(context);
            context.showPopover({
                dataset: { cal: calendar.id, ev: event.id },
                getBoundingClientRect() { return { left: 20, top: 20, bottom: 40 }; },
            });
            return elements.get("popover").innerHTML;
        },
        sharingDetails(time, number, declined = false) {
            context.showPopover({
                dataset: { shareTime: time, ...(number ? { shared: String(number) } : {}) },
                classList: { contains(name) { return name === "declined" && declined; } },
                getBoundingClientRect() { return { left: 20, top: 20, bottom: 40 }; },
            });
            return elements.get("popover").innerHTML;
        },
        block(calendarId, eventId, groupNumber) {
            const classes = new Set();
            const block = {
                dataset: { cal: calendarId, ev: eventId, ...(groupNumber ? { shared: String(groupNumber) } : {}) },
                closest(selector) { return [".ev", "#grid .ev"].includes(selector) ? this : null; },
                classList: {
                    toggle(name, force) { if (force) classes.add(name); else classes.delete(name); },
                    contains(name) { return classes.has(name); },
                },
            };
            blocks.push(block);
            return block;
        },
        dispatch(type, target, relatedTarget = null, properties = {}) {
            for (const listener of listeners.get(type) || []) listener({ target, relatedTarget, ...properties });
        },
        highlighted() {
            return blocks.filter((block) => block.classList.contains("peer-highlight"));
        },
        element(id) {
            return context.document.getElementById(id);
        },
        setData(data) {
            context.payload = data;
            new Script("state.data = payload").runInContext(context);
            context.renderPresets(data);
        },
        usePresetFetch(handler) {
            context.fetch = handler;
            context.apply = (data) => {
                context.payload = data;
                new Script("state.data = payload").runInContext(context);
                context.renderPresets(data);
            };
        },
        useFetch(handler) {
            context.fetch = handler;
        },
        setFocus(element) {
            context.document.activeElement = element;
        },
        activeElement() {
            return context.document.activeElement;
        },
        setChipButtons(buttons) {
            context.document.getElementById("chips").querySelectorAll = () => buttons;
        },
        waitForOrder() {
            return new Script("state.orderQueue").runInContext(context);
        },
        async fire(id, type, properties = {}) {
            const element = context.document.getElementById(id);
            const event = { currentTarget: element, target: element, preventDefault() {}, ...properties };
            await Promise.all((element.handlers.get(type) || []).map((handler) => handler(event)));
        },
    };
}

test("loading status shows the animated loading state and clears when complete", () => {
    const renderer = createRenderer();
    const status = renderer.renderStatus({ loading: true });
    assert.equal(status.textContent, "gali で取得中…");
    assert.equal(status.className, "status loading");

    renderer.renderStatus({});
    assert.equal(status.className, "status");
});

test("status identifies full and partial cached results without changing the fetch time", () => {
    const renderer = createRenderer();
    const snapshot = {
        fetchedAt: "2026-10-12T00:00:00Z",
        usingReferences: true,
        calendars: [],
        cache: { hits: 2, chunks: 3 },
    };
    const status = renderer.renderStatus({ snapshot });
    assert.match(status.textContent, /^最終取得 \d{2}:\d{2} \/ キャッシュ 2\/3 \/ 参照カレンダー/);
    snapshot.cache = { hits: 3, chunks: 3 };
    renderer.renderStatus({ snapshot });
    assert.match(status.textContent, / \/ キャッシュ \/ 参照カレンダー/);
    snapshot.cache = { hits: 0, chunks: 3 };
    renderer.renderStatus({ snapshot });
    assert.doesNotMatch(status.textContent, /キャッシュ/);
});

function orderingData(days = ["2026-10-12"]) {
    const calendars = ["alice", "bob", "charlie"].map((id) => ({
        id,
        label: id.toUpperCase(),
        color: "#3f7ee8",
        error: null,
        stats: { total: days.length, hidden: 0, declined: 0 },
        events: days.map((day) => ({
            id: `${id}-${day}`, summary: id, detailsVisible: true, allDay: false,
            start: `${day}T09:00:00`, end: `${day}T10:00:00`,
        })),
    }));
    return {
        profile: "test",
        revision: 1,
        settings: {
            calendars: calendars.map(({ id, label }) => ({ id, label })),
            refs: [], view: "day", workStart: "09:00", workEnd: "18:00",
        },
        snapshot: { calendars, range: { days }, fetchedAt: "2026-10-12T00:00:00Z" },
        range: { days },
        presets: [],
        freeSlots: [],
    };
}

function dateData(anchor, view = "day", revision = 1) {
    const date = new Date(`${anchor}T00:00:00Z`);
    const length = view === "week" ? 7 : view === "3days" ? 3 : 1;
    const days = Array.from({ length }, (_, index) => {
        const day = new Date(date);
        day.setUTCDate(day.getUTCDate() + index);
        return day.toISOString().slice(0, 10);
    });
    const data = orderingData(days);
    data.revision = revision;
    data.settings = { ...data.settings, anchor, view };
    data.range = { anchor, since: days[0], until: days[days.length - 1], days };
    data.snapshot.range = data.range;
    return data;
}

test("the displayed range is the calendar button and no separate date input exists", async () => {
    const html = await readFile(new URL("./ui/index.html", import.meta.url), "utf8");
    assert.match(html, /<h1 class="range-heading">\s*<button\s+type="button"\s+id="date-picker-toggle"\s+aria-haspopup="dialog"\s+aria-controls="date-calendar"/);
    assert.match(html, /<span id="range-label">読み込み中…<\/span>/);
    assert.doesNotMatch(html, /anchor-date|type="date"|data-nav="today"/);
    assert.match(html, /data-nav="prev"/);
    assert.match(html, /data-nav="next"/);
    assert.match(html, /aria-describedby="date-picker-error"/);
    assert.match(html, /id="date-picker-error" role="alert" hidden/);
    assert.match(html, /<dialog class="date-dialog" id="date-calendar" aria-labelledby="date-calendar-title">[\s\S]*?<button type="button" id="date-calendar-today">今日<\/button>[\s\S]*?<\/dialog>/);
    assert.match(html, /role="grid" aria-labelledby="date-calendar-month"/);
    assert.match(html, /id="date-calendar-month" aria-live="polite"/);
    for (const weekday of ["日", "月", "火", "水", "木", "金", "土"]) {
        assert.match(html, new RegExp(`<th scope="col" abbr="${weekday}曜日">${weekday}</th>`));
    }
    assert.ok(html.indexOf('abbr="日曜日"') < html.indexOf('abbr="月曜日"'));
});

async function pickCalendarDay(renderer, date) {
    await renderer.fire("date-picker-toggle", "click");
    const day = renderer.element("date-calendar-days").querySelector(`[data-picker-date="${date}"]`);
    return renderer.fire("date-calendar-days", "click", { target: day });
}

function focusedCalendarDate(renderer) {
    return renderer.activeElement()?.dataset?.pickerDate;
}

function focusCalendarDay(renderer, date) {
    renderer.element("date-calendar-days").querySelector(`[data-picker-date="${date}"]`).focus();
}

async function calendarKey(renderer, key, shiftKey = false) {
    let prevented = false;
    await renderer.fire("date-calendar-days", "keydown", {
        target: renderer.activeElement(),
        key,
        shiftKey,
        preventDefault() { prevented = true; },
    });
    assert.equal(prevented, true);
}

test("calendar dialog keeps its focused month through live updates and restores focus on close", async () => {
    const renderer = createRenderer();
    renderer.apply(dateData("2026-03-04", "week"));
    const toggle = renderer.element("date-picker-toggle");
    const dialog = renderer.element("date-calendar");
    assert.equal(toggle.disabled, false);
    await renderer.fire("date-picker-toggle", "click");
    assert.equal(dialog.open, true);
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    assert.equal(renderer.element("date-calendar-month").textContent, "2026年3月");
    assert.equal(focusedCalendarDate(renderer), "2026-03-04");
    const markup = renderer.element("date-calendar-days").innerHTML;
    assert.match(markup, /aria-selected="true" class="in-range"><button[^>]+data-picker-date="2026-03-04" tabindex="0" aria-label="2026年3月4日 水曜日"/);
    const highlighted = [...markup.matchAll(/class="in-range"><button[^>]+data-picker-date="([^"]+)"/g)].map((match) => match[1]);
    assert.deepEqual(highlighted, ["2026-03-04", "2026-03-05", "2026-03-06", "2026-03-07", "2026-03-08", "2026-03-09", "2026-03-10"]);
    assert.match(markup, /^<tr><td role="gridcell"[^>]*><button[^>]+data-picker-date="2026-03-01"/);

    const focused = renderer.activeElement();
    renderer.apply(dateData("2026-04-15", "week", 2));
    assert.equal(renderer.element("date-calendar-month").textContent, "2026年3月");
    assert.equal(renderer.element("date-calendar-days").innerHTML, markup);
    assert.equal(renderer.activeElement(), focused);

    await renderer.fire("date-calendar-close", "click");
    assert.equal(dialog.open, false);
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    assert.equal(renderer.activeElement(), toggle);
    await renderer.fire("date-picker-toggle", "click");
    assert.equal(focusedCalendarDate(renderer), "2026-04-15");
});

test("the calendar starts at the displayed start date for each view", async () => {
    for (const view of ["day", "3days", "week"]) {
        const renderer = createRenderer();
        renderer.apply(dateData("2026-03-04", view));
        await renderer.fire("date-picker-toggle", "click");
        assert.equal(focusedCalendarDate(renderer), "2026-03-04");
        assert.match(renderer.element("date-calendar-days").innerHTML, /aria-selected="true"[^>]*><button[^>]+data-picker-date="2026-03-04"/);
    }
});

test("selecting a calendar day preserves the view and sends the selected anchor", async () => {
    for (const view of ["day", "3days", "week"]) {
        const renderer = createRenderer();
        renderer.apply(dateData("2026-11-04", view));
        const calls = [];
        renderer.useFetch(async (url, options) => {
            calls.push({ route: new URL(url, "http://localhost").pathname, body: JSON.parse(options.body) });
            return { ok: true, json: async () => dateData("2026-11-13", view, 2) };
        });
        await renderer.fire("date-picker-toggle", "click");
        const day = renderer.element("date-calendar-days").querySelector('[data-picker-date="2026-11-13"]');
        await renderer.fire("date-calendar-days", "click", { target: day });
        assert.deepEqual(calls, [{ route: "/api/settings", body: { settings: { anchor: "2026-11-13" }, refresh: true } }]);
        assert.equal(renderer.data().range.anchor, "2026-11-13");
        assert.equal(renderer.data().range.since, "2026-11-13");
        assert.equal(renderer.data().settings.view, view);
        assert.equal(renderer.element("date-calendar").open, false);
        assert.equal(renderer.activeElement(), renderer.element("date-picker-toggle"));
    }
});

test("choosing a day within the displayed week makes it the new start", async () => {
    const renderer = createRenderer();
    renderer.apply(dateData("2026-03-04", "week"));
    const calls = [];
    renderer.useFetch(async (_url, options) => {
        calls.push(JSON.parse(options.body));
        return { ok: true, json: async () => dateData("2026-03-06", "week", 2) };
    });
    await pickCalendarDay(renderer, "2026-03-06");
    assert.deepEqual(calls, [{ settings: { anchor: "2026-03-06" }, refresh: true }]);
    assert.deepEqual(renderer.data().range.days, [
        "2026-03-06", "2026-03-07", "2026-03-08", "2026-03-09", "2026-03-10", "2026-03-11", "2026-03-12",
    ]);
    assert.equal(renderer.element("range-label").textContent, "2026年 3/6 (金) – 3/12 (木)");
    await renderer.fire("date-picker-toggle", "click");
    assert.equal(focusedCalendarDate(renderer), "2026-03-06");
});

test("week ranges show both years and highlight dates across months", async () => {
    const renderer = createRenderer();
    renderer.apply(dateData("2026-12-30", "week"));
    assert.equal(renderer.element("range-label").textContent, "2026年 12/30 (水) – 2027年 1/5 (火)");
    await renderer.fire("date-picker-toggle", "click");
    assert.equal(focusedCalendarDate(renderer), "2026-12-30");
    await renderer.fire("date-calendar-next", "click");
    const markup = renderer.element("date-calendar-days").innerHTML;
    const highlighted = [...markup.matchAll(/class="in-range"><button[^>]+data-picker-date="([^"]+)"/g)].map((match) => match[1]);
    assert.deepEqual(highlighted, ["2027-01-01", "2027-01-02", "2027-01-03", "2027-01-04", "2027-01-05"]);
});

test("calendar selection reports an API failure and keeps the previous range", async () => {
    const renderer = createRenderer();
    renderer.apply(dateData("2026-03-03", "week"));
    renderer.useFetch(async () => { throw new Error("offline"); });
    await pickCalendarDay(renderer, "2026-03-11");
    assert.equal(renderer.element("date-calendar").open, false);
    assert.equal(renderer.data().range.since, "2026-03-03");
    assert.match(renderer.element("date-picker-error").textContent, /offline/);
});

test("calendar navigation handles month ends, leap years, and keyboard movement", async () => {
    const renderer = createRenderer();
    renderer.apply(dateData("2024-01-31"));
    await renderer.fire("date-picker-toggle", "click");
    await renderer.fire("date-calendar-next", "click");
    assert.equal(renderer.activeElement(), renderer.element("date-calendar-next"));
    focusCalendarDay(renderer, "2024-02-29");
    assert.equal(focusedCalendarDate(renderer), "2024-02-29");
    await calendarKey(renderer, "ArrowRight");
    assert.equal(focusedCalendarDate(renderer), "2024-03-01");
    await calendarKey(renderer, "ArrowLeft");
    assert.equal(focusedCalendarDate(renderer), "2024-02-29");
    await calendarKey(renderer, "ArrowUp");
    assert.equal(focusedCalendarDate(renderer), "2024-02-22");
    await calendarKey(renderer, "ArrowDown");
    assert.equal(focusedCalendarDate(renderer), "2024-02-29");
    await calendarKey(renderer, "Home");
    assert.equal(focusedCalendarDate(renderer), "2024-02-25");
    await calendarKey(renderer, "End");
    assert.equal(focusedCalendarDate(renderer), "2024-03-02");
    await calendarKey(renderer, "PageUp");
    assert.equal(focusedCalendarDate(renderer), "2024-02-02");
    await calendarKey(renderer, "PageDown", true);
    assert.equal(focusedCalendarDate(renderer), "2025-02-02");
    await renderer.fire("date-calendar-close", "click");

    renderer.apply(dateData("2025-01-31", "day", 2));
    await renderer.fire("date-picker-toggle", "click");
    await renderer.fire("date-calendar-next", "click");
    assert.equal(renderer.activeElement(), renderer.element("date-calendar-next"));
    focusCalendarDay(renderer, "2025-02-28");
    assert.equal(focusedCalendarDate(renderer), "2025-02-28");
    await renderer.fire("date-calendar-prev", "click");
    assert.equal(renderer.activeElement(), renderer.element("date-calendar-prev"));
    focusCalendarDay(renderer, "2025-01-28");
    assert.equal(focusedCalendarDate(renderer), "2025-01-28");
});

test("calendar columns start on Sunday and keyboard week edges follow that order", async () => {
    const renderer = createRenderer();
    renderer.apply(dateData("2026-04-15"));
    await renderer.fire("date-picker-toggle", "click");
    const markup = renderer.element("date-calendar-days").innerHTML;
    assert.match(markup, /^<tr>(?:<td role="presentation"><\/td>){3}<td role="gridcell"[^>]*><button[^>]+data-picker-date="2026-04-01"/);
    const monthDates = [...markup.matchAll(/data-picker-date="2026-04-(\d{2})"/g)].map((match) => Number(match[1]));
    assert.equal(monthDates[0], 1);
    assert.equal(new Date(Date.UTC(2026, 3, 1)).getUTCDay(), 3);

    focusCalendarDay(renderer, "2026-04-15");
    await calendarKey(renderer, "Home");
    assert.equal(focusedCalendarDate(renderer), "2026-04-12");
    await calendarKey(renderer, "End");
    assert.equal(focusedCalendarDate(renderer), "2026-04-18");
});

test("repeated month-button activation keeps focus and does not select a date", async () => {
    const renderer = createRenderer();
    renderer.apply(dateData("2024-01-31"));
    let calls = 0;
    renderer.useFetch(async () => { calls += 1; throw new Error("unexpected request"); });
    await renderer.fire("date-picker-toggle", "click");
    for (const month of ["2024年2月", "2024年3月"]) {
        await renderer.fire("date-calendar-next", "click");
        assert.equal(renderer.element("date-calendar-month").textContent, month);
        assert.equal(renderer.activeElement(), renderer.element("date-calendar-next"));
    }
    for (const month of ["2024年2月", "2024年1月"]) {
        await renderer.fire("date-calendar-prev", "click");
        assert.equal(renderer.element("date-calendar-month").textContent, month);
        assert.equal(renderer.activeElement(), renderer.element("date-calendar-prev"));
    }
    assert.equal(renderer.element("date-calendar").open, true);
    assert.equal(calls, 0);
});

test("month navigation moves focus to the heading when its button becomes disabled", async () => {
    for (const [anchor, button, month] of [
        ["0101-02-01", "date-calendar-prev", "101年1月"],
        ["9998-11-30", "date-calendar-next", "9998年12月"],
    ]) {
        const renderer = createRenderer();
        renderer.apply(dateData(anchor));
        await renderer.fire("date-picker-toggle", "click");
        await renderer.fire(button, "click");
        assert.equal(renderer.element("date-calendar-month").textContent, month);
        assert.equal(renderer.element(button).disabled, true);
        assert.equal(renderer.activeElement(), renderer.element("date-calendar-month"));
        assert.equal(renderer.element("date-calendar").open, true);
    }
});

test("calendar navigation cannot move beyond supported years", async () => {
    const renderer = createRenderer();
    renderer.apply(dateData("0101-01-01"));
    await renderer.fire("date-picker-toggle", "click");
    assert.equal(renderer.element("date-calendar-prev").disabled, true);
    for (const key of ["ArrowLeft", "ArrowUp", "Home", "PageUp"]) {
        await calendarKey(renderer, key);
        assert.equal(focusedCalendarDate(renderer), "0101-01-01");
    }
    await calendarKey(renderer, "PageUp", true);
    assert.equal(focusedCalendarDate(renderer), "0101-01-01");
    await renderer.fire("date-calendar-close", "click");

    renderer.apply(dateData("9998-12-31", "day", 2));
    await renderer.fire("date-picker-toggle", "click");
    assert.equal(renderer.element("date-calendar-next").disabled, true);
    for (const key of ["ArrowRight", "ArrowDown", "End", "PageDown"]) {
        await calendarKey(renderer, key);
        assert.equal(focusedCalendarDate(renderer), "9998-12-31");
    }
    await calendarKey(renderer, "PageDown", true);
    assert.equal(focusedCalendarDate(renderer), "9998-12-31");
});

test("the first and last supported dates can be selected", async () => {
    for (const [initial, anchor] of [["0101-01-02", "0101-01-01"], ["9998-12-30", "9998-12-31"]]) {
        const renderer = createRenderer();
        renderer.apply(dateData(initial));
        let calls = 0;
        renderer.useFetch(async (_url, options) => {
            calls += 1;
            const selected = JSON.parse(options.body).settings.anchor;
            return { ok: true, json: async () => dateData(selected, "day", 2) };
        });
        await renderer.fire("date-picker-toggle", "click");
        const day = renderer.element("date-calendar-days").querySelector(`[data-picker-date="${anchor}"]`);
        await renderer.fire("date-calendar-days", "click", { target: day });
        assert.equal(renderer.data().range.anchor, anchor);
        assert.equal(renderer.element("date-picker-error").hidden, true);
        assert.equal(calls, 1);
    }
});

test("today is marked in the calendar", async () => {
    const date = new Date();
    const today = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    const renderer = createRenderer();
    renderer.apply(dateData(today));
    await renderer.fire("date-picker-toggle", "click");
    assert.match(renderer.element("date-calendar-days").innerHTML, new RegExp(`data-picker-date="${today}"[^>]+aria-current="date"`));
});

test("the calendar today button selects the local date and preserves the view", async () => {
    const now = new Date(2026, 2, 15, 0, 5).getTime();
    const today = "2026-03-15";
    for (const view of ["day", "3days", "week"]) {
        const renderer = createRenderer({ now });
        renderer.apply(dateData("2024-01-01", view));
        const calls = [];
        renderer.useFetch(async (url, options) => {
            calls.push({ route: new URL(url, "http://localhost").pathname, body: JSON.parse(options.body) });
            return { ok: true, json: async () => dateData(today, view, 2) };
        });
        await renderer.fire("date-picker-toggle", "click");
        renderer.setFocus(renderer.element("date-calendar-today"));
        await renderer.fire("date-calendar-today", "click");
        assert.deepEqual(calls, [{ route: "/api/settings", body: { settings: { anchor: today }, refresh: true } }]);
        assert.equal(renderer.data().settings.view, view);
        assert.equal(renderer.data().range.anchor, today);
        assert.equal(renderer.data().range.since, today);
        assert.equal(renderer.element("date-calendar").open, false);
        assert.equal(renderer.element("date-picker-toggle").getAttribute("aria-expanded"), "false");
        assert.equal(renderer.activeElement(), renderer.element("date-picker-toggle"));
    }
});

test("the calendar today button avoids a request when already at today", async () => {
    const now = new Date(2026, 2, 15, 23, 55).getTime();
    const renderer = createRenderer({ now });
    renderer.apply(dateData("2026-03-15"));
    let calls = 0;
    renderer.useFetch(async () => { calls += 1; throw new Error("unexpected request"); });
    await renderer.fire("date-picker-toggle", "click");
    await renderer.fire("date-calendar-today", "click");
    assert.equal(calls, 0);
    assert.equal(renderer.element("date-calendar").open, false);
});

test("the calendar today button reports a failed date change", async () => {
    const now = new Date(2026, 2, 15, 12).getTime();
    const renderer = createRenderer({ now });
    renderer.apply(dateData("2024-01-01"));
    renderer.useFetch(async () => { throw new Error("offline"); });
    await renderer.fire("date-picker-toggle", "click");
    await renderer.fire("date-calendar-today", "click");
    assert.equal(renderer.data().range.anchor, "2024-01-01");
    assert.equal(renderer.element("date-calendar").open, false);
    assert.match(renderer.element("date-picker-error").textContent, /offline/);
});

test("choosing the displayed start date or a pending date sends no extra request", async () => {
    const renderer = createRenderer();
    renderer.apply(dateData("2026-03-04", "week"));
    let calls = 0;
    let resolveResponse;
    renderer.useFetch(() => {
        calls += 1;
        return new Promise((resolve) => { resolveResponse = resolve; });
    });
    await pickCalendarDay(renderer, "2026-03-04");
    assert.equal(calls, 0);
    const request = pickCalendarDay(renderer, "2026-03-11");
    await pickCalendarDay(renderer, "2026-03-11");
    assert.equal(calls, 1);
    resolveResponse({ ok: true, json: async () => dateData("2026-03-11", "week", 2) });
    await request;
    assert.equal(renderer.data().range.since, "2026-03-11");
});

test("a calendar opening failure is reported without changing the anchor", async () => {
    const renderer = createRenderer();
    renderer.apply(dateData("2026-03-03"));
    renderer.element("date-calendar").showModal = () => { throw new Error("unavailable"); };
    await renderer.fire("date-picker-toggle", "click");
    assert.match(renderer.element("date-picker-error").textContent, /unavailable/);
    assert.equal(renderer.data().range.anchor, "2026-03-03");
    assert.notEqual(renderer.element("date-picker-toggle").getAttribute("aria-expanded"), "true");
});

test("date selection reports rejected changes but keeps an acknowledged date", async () => {
    const renderer = createRenderer();
    renderer.apply(dateData("2026-03-03"));
    renderer.useFetch(async () => ({
        ok: true,
        json: async () => ({ ...dateData("2026-03-03", "day", 2), error: "保存に失敗しました" }),
    }));
    await pickCalendarDay(renderer, "2026-03-04");
    assert.equal(renderer.data().range.anchor, "2026-03-03");
    assert.match(renderer.element("date-picker-error").textContent, /保存に失敗しました/);

    renderer.useFetch(async () => {
        renderer.apply(dateData("2026-03-04", "day", 3));
        throw new Error("response was lost after saving");
    });
    await pickCalendarDay(renderer, "2026-03-04");
    assert.equal(renderer.data().range.anchor, "2026-03-04");
    assert.equal(renderer.element("date-picker-error").hidden, true);
});

test("an older failed date request cannot undo a later selection", async () => {
    const renderer = createRenderer();
    renderer.apply(dateData("2026-03-03"));
    let rejectFirst;
    const firstResponse = new Promise((_, reject) => { rejectFirst = reject; });
    renderer.useFetch(async (_url, options) => {
        const { anchor } = JSON.parse(options.body).settings;
        if (anchor === "2026-03-04") return firstResponse;
        return { ok: true, json: async () => dateData("2026-03-05", "day", 2) };
    });
    const first = pickCalendarDay(renderer, "2026-03-04");
    await pickCalendarDay(renderer, "2026-03-05");
    rejectFirst(new Error("older request failed"));
    await first;
    assert.equal(renderer.data().range.anchor, "2026-03-05");
    assert.equal(renderer.element("date-picker-error").hidden, true);
});

test("calendar headers and event columns follow the same order on every day", () => {
    const renderer = createRenderer();
    for (const count of [1, 3, 7]) {
        const days = Array.from({ length: count }, (_, index) => `2026-10-${12 + index}`);
        const data = orderingData(days);
        data.settings.calendars.reverse();
        data.snapshot.calendars.reverse();
        const html = renderer.render(data);
        const expected = days.flatMap(() => ["charlie", "bob", "alice"]);
        assert.deepEqual([...html.matchAll(/data-order-calendar="([^"]+)"/g)].map((match) => match[1]), expected);
        assert.deepEqual([...html.matchAll(/data-cal="([^"]+)"/g)].map((match) => match[1]), expected);
        assert.equal([...html.matchAll(/draggable="true"/g)].length, count * 3);
    }
});

test("calendar order controls expose boundaries and preserve keyboard focus", () => {
    const renderer = createRenderer();
    const data = orderingData();
    let html = renderer.renderChips(data);
    assert.match(html, /data-move-calendar="alice" data-direction="left"[^>]*title="左へ移動" disabled/);
    assert.match(html, /data-move-calendar="charlie" data-direction="right"[^>]*title="右へ移動" disabled/);
    assert.match(html, /aria-label="BOBを左へ移動"/);
    const active = { dataset: { moveCalendar: "bob", direction: "left" } };
    const left = { dataset: active.dataset, disabled: false, focus() { this.focused = true; } };
    const right = { dataset: { moveCalendar: "bob", direction: "right" }, disabled: false, focus() { this.focused = true; } };
    renderer.setFocus(active);
    renderer.setChipButtons([left, right]);
    renderer.renderChips(data);
    assert.equal(left.focused, true);
    left.focused = false;
    left.disabled = true;
    renderer.renderChips(data);
    assert.equal(left.focused, false);
    assert.equal(right.focused, true);
    html = renderer.renderChips({ ...data, settings: { ...data.settings, calendars: data.settings.calendars.slice(0, 1) } });
    assert.doesNotMatch(html, /data-move-calendar/);
});

test("drag and buttons send relative moves, keep newest data, and show errors", async () => {
    const renderer = createRenderer();
    let data = orderingData();
    const calls = [];
    renderer.useFetch(async (url, options) => {
        const body = JSON.parse(options.body);
        calls.push({ route: new URL(url, "http://localhost").pathname, body });
        if (body.id === "missing") return { ok: false, json: async () => ({ error: "カレンダーが見つかりません" }) };
        const entries = [...data.settings.calendars];
        const from = entries.findIndex((entry) => entry.id === body.id);
        const [moving] = entries.splice(from, 1);
        const target = body.direction
            ? from + (body.direction === "left" ? -1 : 1)
            : entries.findIndex((entry) => entry.id === body.targetId) + (body.position === "after" ? 1 : 0);
        entries.splice(target, 0, moving);
        const byId = new Map(data.snapshot.calendars.map((calendar) => [calendar.id, calendar]));
        data = {
            ...data,
            revision: data.revision + 1,
            settings: { ...data.settings, calendars: entries },
            snapshot: { ...data.snapshot, calendars: entries.map((entry) => byId.get(entry.id)) },
        };
        return { ok: true, json: async () => data };
    });
    renderer.apply(data);

    const classes = () => {
        const values = new Set();
        return {
            add(...names) { for (const name of names) values.add(name); },
            remove(...names) { for (const name of names) values.delete(name); },
            contains(name) { return values.has(name); },
        };
    };
    const header = (id, left) => ({
        dataset: { orderCalendar: id },
        classList: classes(),
        closest(selector) { return selector === "#grid th[data-order-calendar]" ? this : null; },
        getBoundingClientRect() { return { left, width: 100 }; },
    });
    const source = header("alice", 0);
    const target = header("charlie", 200);
    const transfer = { setData() {} };
    renderer.dispatch("dragstart", source, null, { dataTransfer: transfer });
    renderer.dispatch("dragover", target, null, { clientX: 280, dataTransfer: transfer, preventDefault() {} });
    assert.equal(target.classList.contains("drop-after"), true);

    const before = renderer.element("grid").innerHTML;
    const newer = { ...data, revision: 2 };
    renderer.apply(newer);
    assert.equal(renderer.element("grid").innerHTML, before);
    data = newer;
    renderer.dispatch("drop", target, null, { clientX: 280, preventDefault() {} });
    await renderer.waitForOrder();
    assert.deepEqual(calls[0], {
        route: "/api/calendars/move", body: { id: "alice", targetId: "charlie", position: "after" },
    });
    assert.deepEqual(data.settings.calendars.map((entry) => entry.id), ["bob", "charlie", "alice"]);
    assert.match(renderer.element("calendar-order-message").textContent, /ALICE を 3 番目/);
    renderer.apply({ ...orderingData(), revision: 1 });
    assert.equal(renderer.data().revision, data.revision);

    const button = {
        dataset: { moveCalendar: "charlie", direction: "left" },
        closest(selector) { return selector === "[data-move-calendar]" ? this : null; },
    };
    renderer.dispatch("click", button);
    await renderer.waitForOrder();
    assert.deepEqual(calls[1].body, { id: "charlie", direction: "left" });
    assert.deepEqual(data.settings.calendars.map((entry) => entry.id), ["charlie", "bob", "alice"]);

    button.dataset.moveCalendar = "missing";
    renderer.dispatch("click", button);
    await renderer.waitForOrder();
    assert.match(renderer.element("calendar-order-message").textContent, /並び替えに失敗しました/);
    assert.equal(renderer.element("calendar-order-message").className, "status error");
});

test("preset creation and update wait for all earlier calendar moves", async () => {
    for (const mode of ["create", "update"]) {
        const renderer = createRenderer();
        const calendars = ["alice", "bob", "charlie"].map((id) => ({ id, label: id }));
        const existing = { id: "saved", name: "Team", calendars: [calendars[0]] };
        let data = { settings: { calendars }, presets: mode === "update" ? [existing] : [] };
        const calls = [];
        let release;
        const gate = new Promise((resolve) => { release = resolve; });
        let markStarted;
        const started = new Promise((resolve) => { markStarted = resolve; });
        renderer.setData(data);
        renderer.element("preset-name").value = "Team";
        await renderer.fire("preset-name", "input");
        if (mode === "update") {
            renderer.element("preset-select").value = "saved";
            await renderer.fire("preset-select", "change");
        }
        renderer.usePresetFetch(async (url, options) => {
            const route = new URL(url, "http://localhost").pathname;
            const body = JSON.parse(options.body);
            calls.push(route);
            if (route === "/api/calendars/move") {
                if (calls.length === 1) {
                    markStarted();
                    await gate;
                }
                const next = [...data.settings.calendars];
                const index = next.findIndex((entry) => entry.id === body.id);
                [next[index - 1], next[index]] = [next[index], next[index - 1]];
                data = { ...data, settings: { ...data.settings, calendars: next } };
                return { ok: true, json: async () => data };
            }
            const preset = { id: "saved", name: "Team", calendars: data.settings.calendars };
            data = { ...data, presets: [preset] };
            return { ok: true, json: async () => ({ ...data, preset }) };
        });
        const button = {
            dataset: { moveCalendar: "charlie", direction: "left" },
            closest(selector) { return selector === "[data-move-calendar]" ? this : null; },
        };
        renderer.dispatch("click", button);
        renderer.dispatch("click", button);
        const saving = renderer.fire(mode === "create" ? "save-preset" : "update-preset", "click");
        await started;
        assert.deepEqual(calls, ["/api/calendars/move"]);
        release();
        await saving;
        assert.deepEqual(calls, ["/api/calendars/move", "/api/calendars/move", `/api/presets/${mode}`]);
        assert.deepEqual(data.presets[0].calendars.map((entry) => entry.id), ["charlie", "alice", "bob"]);
    }
});

test("a preset save queued behind a failed move is canceled visibly and can be retried", async () => {
    const renderer = createRenderer();
    const data = { settings: { calendars: [{ id: "alice", label: "Alice" }, { id: "bob", label: "Bob" }] }, presets: [] };
    const calls = [];
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let markStarted;
    const started = new Promise((resolve) => { markStarted = resolve; });
    renderer.setData(data);
    renderer.element("preset-name").value = "Team";
    await renderer.fire("preset-name", "input");
    renderer.usePresetFetch(async (url) => {
        const route = new URL(url, "http://localhost").pathname;
        calls.push(route);
        if (route === "/api/calendars/move") {
            markStarted();
            await gate;
            return { ok: false, json: async () => ({ error: "移動先が見つかりません" }) };
        }
        const preset = { id: "saved", name: "Team", calendars: data.settings.calendars };
        return { ok: true, json: async () => ({ ...data, presets: [preset], preset }) };
    });
    const button = {
        dataset: { moveCalendar: "bob", direction: "left" },
        closest(selector) { return selector === "[data-move-calendar]" ? this : null; },
    };
    renderer.dispatch("click", button);
    const saving = renderer.fire("save-preset", "click");
    await started;
    release();
    await saving;
    assert.deepEqual(calls, ["/api/calendars/move"]);
    assert.match(renderer.element("preset-message").textContent, /並び替えに失敗/);
    assert.equal(renderer.element("preset-name").value, "Team");
    await renderer.fire("save-preset", "click");
    assert.deepEqual(calls, ["/api/calendars/move", "/api/presets/create"]);
});

test("hourly grid lines render without array-separator text", () => {
    const renderer = createRenderer();
    for (const dayCount of [1, 3, 7]) {
        for (const calendarCount of [1, 2]) {
            const days = Array.from({ length: dayCount }, (_, index) => `2026-10-${12 + index}`);
            const calendars = Array.from({ length: calendarCount }, (_, index) => ({
                id: `calendar-${index}`,
                label: `Calendar ${index}`,
                color: "#3f7ee8",
                events: [],
            }));
            const html = renderer.render({
                settings: { calendars, workStart: "09:00", workEnd: "18:00" },
                snapshot: { calendars, range: { days } },
            });

            const columns = [...html.matchAll(/<div class="col"[^>]*>(.*?)<\/div><\/td>/gs)];
            assert.equal(columns.length, dayCount * calendarCount);
            for (const [, column] of columns) {
                assert.equal(column.replace(/<[^>]*>/g, "").trim(), "");
                const positions = [...column.matchAll(/class="hline" style="top:(\d+)px"/g)]
                    .map((match) => Number(match[1]));
                assert.deepEqual(positions, Array.from({ length: 23 }, (_, index) => (index + 1) * layout.HOUR_HEIGHT));
            }
            assert.match(html, />00:00<\/span>/);
            assert.match(html, />24:00<\/span>/);
        }
    }
});

test("completion source appears in timed and all-day badges and details", () => {
    const renderer = createRenderer();
    const calendar = { id: "target@example.com", label: "Target", color: "#3f7ee8" };
    const source = 'room"<&>@example.com';
    const escapedSource = "room&quot;&lt;&amp;&gt;@example.com";
    for (const allDay of [false, true]) {
        const event = {
            id: "meeting", summary: "Meeting", detailsVisible: true, allDay,
            start: allDay ? "2026-10-12" : "2026-10-12T09:00:00+09:00",
            end: allDay ? "2026-10-13" : "2026-10-12T10:00:00+09:00",
            completed: true, completedFrom: source, completionInferred: false,
        };
        const settings = { showCompletionDiff: true };
        const markup = renderer.eventMarkup(event, calendar, settings);
        assert.ok(markup.includes(`title="補完元: ${escapedSource}"`));
        assert.ok(markup.includes(">補</span>"));
        assert.ok(!markup.includes(source));
        const details = renderer.details(event, calendar);
        assert.ok(details.includes(`<dt>補完元カレンダー</dt><dd>${escapedSource}</dd>`));
        assert.ok(!details.includes("推定"));
        assert.ok(!renderer.eventMarkup(event, calendar, { showCompletionDiff: false }).includes('class="badge"'));

        const named = { ...event, completedFromName: 'Room "<&>' };
        const escapedName = "Room &quot;&lt;&amp;&gt;";
        const namedMarkup = renderer.eventMarkup(named, calendar, settings);
        assert.ok(namedMarkup.includes(`title="補完元: ${escapedName}"`));
        assert.ok(!namedMarkup.includes(escapedSource));
        const namedDetails = renderer.details(named, calendar);
        assert.ok(namedDetails.includes(`<dt>補完元カレンダー</dt><dd>${escapedName}</dd>`));
        assert.ok(namedDetails.includes(`<dt>補完元 ID</dt><dd>${escapedSource}</dd>`));
        const sameName = { ...event, completedFromName: source };
        assert.ok(!renderer.details(sameName, calendar).includes("<dt>補完元 ID</dt>"));

        const inferred = { ...event, completedFrom: "", completionInferred: true };
        assert.ok(renderer.eventMarkup(inferred, calendar, settings).includes(">補?</span>"));
        assert.ok(renderer.details(inferred, calendar).includes("推定・補完元不明"));
        const direct = { ...inferred, completed: false, completionInferred: false };
        assert.ok(!renderer.eventMarkup(direct, calendar, settings).includes('class="badge"'));
        assert.ok(!renderer.details(direct, calendar).includes("補完元カレンダー"));
    }
});

function sharedData(allDay = false) {
    const privateEvent = {
        id: "meeting", uid: "meeting@example.com", summary: "Hidden private summary", detailsVisible: false, allDay,
        start: allDay ? "2026-10-12" : "2026-10-12T18:00:00",
        end: allDay ? "2026-10-13" : "2026-10-12T18:30:00",
    };
    const calendars = [
        { id: "alice", label: "Alice", color: "#3f7ee8", events: [privateEvent] },
        { id: "bob", label: 'Bob "<&>', color: "#3f7ee8", events: [{ ...privateEvent }] },
    ];
    return {
        settings: { calendars, workStart: "09:00", workEnd: "18:00", showCompletionDiff: false },
        snapshot: { calendars, range: { days: ["2026-10-12"] } },
    };
}

function joinedData(allDay = false) {
    const data = sharedData(allDay);
    const calendars = data.snapshot.calendars;
    calendars[0].events[0].id = "meeting-alice";
    calendars[1].events[0].id = "meeting-bob";
    calendars.push({
        id: "carol", label: "Carol", color: "#bc4c00",
        events: [{ ...calendars[0].events[0], id: "meeting-carol" }],
    });
    return data;
}

function gridEventBlocks(html) {
    return [...html.matchAll(/<button type="button" class="([^"]*)"([\s\S]*?)<\/button>/g)].map((match) => ({
        classes: new Set(match[1].split(" ")),
        calendar: /data-cal="([^"]*)"/.exec(match[2])?.[1],
        event: /data-ev="([^"]*)"/.exec(match[2])?.[1],
        shared: /data-shared="([^"]*)"/.exec(match[2])?.[1],
        markup: match[0],
    }));
}

function gridAllDayRows(html) {
    return [...html.matchAll(/<tr class="allday-row(?: allday-last)?">([\s\S]*?)<\/tr>/g)]
        .map((match) => ({
            cells: [...match[1].matchAll(/<td\b/g)].length,
            blocks: gridEventBlocks(match[1]),
        }));
}

function otherTimedEvent(id, start, end) {
    return {
        id, uid: id, summary: `Hidden ${id}`, detailsVisible: true, allDay: false,
        start: `2026-10-12T${start}`, end: `2026-10-12T${end}`,
    };
}

function otherAllDayEvent(id) {
    return {
        id, uid: id, summary: `Hidden ${id}`, detailsVisible: true, allDay: true,
        start: "2026-10-12", end: "2026-10-13",
    };
}

function assertJoins(blocks, expected) {
    assert.deepEqual(blocks.map((block) => [
        block.classes.has("join-left"),
        block.classes.has("join-right"),
    ]), expected);
}

test("adjacent matching timed and all-day events connect only in sharing mode", () => {
    for (const allDay of [false, true]) {
        for (const sharing of [false, true]) {
            const data = joinedData(allDay);
            data.settings.shareMode = sharing;
            const html = createRenderer().render(data);
            const blocks = gridEventBlocks(html);
            assert.equal(blocks.length, 3);
            if (sharing) {
                assertJoins(blocks, [[false, true], [true, true], [true, false]]);
                assert.doesNotMatch(html, /data-cal=|data-ev=|meeting-alice|meeting-bob|meeting-carol|meeting@example\.com|Hidden private summary/);
                assert.equal(blocks.filter((block) => block.markup.includes('data-shared="1"')).length, 3);
            } else {
                assertJoins(blocks, [[false, false], [false, false], [false, false]]);
                assert.deepEqual(blocks.map((block) => block.calendar), ["alice", "bob", "carol"]);
                assert.deepEqual(blocks.map((block) => block.event), ["meeting-alice", "meeting-bob", "meeting-carol"]);
            }
            if (!allDay && sharing) {
                assert.match(blocks[0].markup, /left:0%;width:calc\(100% \+ 1px\)/);
                assert.match(blocks[1].markup, /left:calc\(0% - 1px\);width:calc\(100% \+ 2px\)/);
                assert.match(blocks[2].markup, /left:calc\(0% - 1px\);width:calc\(100% \+ 1px\)/);
            } else if (!allDay) {
                for (const block of blocks) assert.match(block.markup, /left:0%;width:100%/);
            }
        }
    }
});

test("only adjacent matching columns connect, and reordering recalculates the joins", () => {
    for (const allDay of [false, true]) {
        const data = joinedData(allDay);
        data.settings.shareMode = true;
        const calendars = data.snapshot.calendars;
        calendars[1].events = [];
        let blocks = gridEventBlocks(createRenderer().render(data));
        assert.equal(blocks.length, 2);
        assertJoins(blocks, [[false, false], [false, false]]);

        [calendars[1], calendars[2]] = [calendars[2], calendars[1]];
        blocks = gridEventBlocks(createRenderer().render(data));
        assert.equal(blocks.length, 2);
        assertJoins(blocks, [[false, true], [true, false]]);
    }
});

test("identical-looking but unrelated or errored copies never connect", () => {
    for (const allDay of [false, true]) {
        const data = joinedData(allDay);
        data.settings.shareMode = true;
        const calendars = data.snapshot.calendars;
        calendars.pop();
        calendars[1].events[0].uid = "unrelated";
        let blocks = gridEventBlocks(createRenderer().render(data));
        assertJoins(blocks, [[false, false], [false, false]]);

        calendars[1].events[0].uid = calendars[0].events[0].uid;
        calendars[1].error = "unavailable";
        blocks = gridEventBlocks(createRenderer().render(data));
        assertJoins(blocks, [[false, false], [false, false]]);
    }
});

test("multi-day shared events connect within each date but not across date boundaries", () => {
    for (const allDay of [false, true]) {
        const data = joinedData(allDay);
        data.settings.shareMode = true;
        const calendars = data.snapshot.calendars;
        calendars.pop();
        data.snapshot.range.days.push("2026-10-13");
        for (const calendar of calendars) {
            Object.assign(calendar.events[0], allDay
                ? { start: "2026-10-12", end: "2026-10-14" }
                : { start: "2026-10-12T00:00:00", end: "2026-10-14T00:00:00" });
        }
        const blocks = gridEventBlocks(createRenderer().render(data));
        assert.equal(blocks.length, 4);
        assertJoins(blocks, [[false, true], [true, false], [false, true], [true, false]]);
    }
});

test("different underlying end times do not connect even when day-clipped bounds match", () => {
    for (const allDay of [false, true]) {
        const data = joinedData(allDay);
        data.settings.shareMode = true;
        for (const [index, calendar] of data.snapshot.calendars.entries()) {
            Object.assign(calendar.events[0], allDay
                ? { start: "2026-10-12", end: index === 0 ? "2026-10-14" : "2026-10-13" }
                : {
                    start: "2026-10-12T23:00:00",
                    end: index === 0 ? "2026-10-14T08:00:00" : "2026-10-13T12:00:00",
                });
        }
        const blocks = gridEventBlocks(createRenderer().render(data));
        assertJoins(blocks, [[false, false], [false, true], [true, false]]);
    }
});

test("effective default end times match their explicit equivalents", () => {
    for (const allDay of [false, true]) {
        const data = joinedData(allDay);
        data.settings.shareMode = true;
        data.snapshot.calendars[0].events[0].end = "";
        const blocks = gridEventBlocks(createRenderer().render(data));
        assertJoins(blocks, [[false, true], [true, true], [true, false]]);
    }
});

test("equivalent timed end instants connect while invalid all-day end dates do not", () => {
    const timed = joinedData();
    timed.settings.shareMode = true;
    timed.snapshot.calendars[1].events[0].end = new Date(timed.snapshot.calendars[1].events[0].end).toISOString();
    assertJoins(gridEventBlocks(createRenderer().render(timed)), [[false, true], [true, true], [true, false]]);

    const allDay = joinedData(true);
    allDay.settings.shareMode = true;
    for (const calendar of allDay.snapshot.calendars) calendar.events[0].end = "2026-99-99";
    assertJoins(gridEventBlocks(createRenderer().render(allDay)), [[false, false], [false, false], [false, false]]);
});

test("timed copies at open column edges connect despite overlapping events on their other sides", () => {
    const data = joinedData();
    data.settings.shareMode = true;
    const [alice, bob, carol] = data.snapshot.calendars;
    alice.events.unshift(otherTimedEvent("alice-other", "17:55:00", "18:20:00"));
    bob.events.push(otherTimedEvent("bob-other", "18:05:00", "18:20:00"));
    carol.events.unshift(otherTimedEvent("carol-other", "17:55:00", "18:20:00"));
    const renderer = createRenderer();
    const html = renderer.render(data);
    const blocks = gridEventBlocks(html);
    const shared = blocks.filter((block) => block.shared);
    assert.equal(blocks.length, 6);
    assertJoins(shared, [[false, true], [true, false], [false, false]]);
    assertJoins(blocks.filter((block) => !block.shared), [[false, false], [false, false], [false, false]]);
    assert.match(shared[0].markup, /left:50%;width:calc\(50% \+ 1px\)/);
    assert.match(shared[1].markup, /left:calc\(0% - 1px\);width:calc\(50% \+ 1px\)/);
    assert.match(shared[2].markup, /left:50%;width:50%/);
    assert.doesNotMatch(html, /alice-other|bob-other|carol-other|Hidden |data-cal=|data-ev=/);

    data.settings.shareMode = false;
    assertJoins(gridEventBlocks(renderer.render(data)), Array.from({ length: 6 }, () => [false, false]));
});

test("a middle timed copy connects on its exposed side only", () => {
    for (const [otherStart, otherEnd, expected] of [
        ["17:55:00", "18:20:00", [[false, false], [false, true], [true, false]]],
        ["18:05:00", "18:20:00", [[false, true], [true, false], [false, false]]],
    ]) {
        const data = joinedData();
        data.settings.shareMode = true;
        data.snapshot.calendars[1].events.push(otherTimedEvent("other", otherStart, otherEnd));
        const blocks = gridEventBlocks(createRenderer().render(data));
        assertJoins(blocks.filter((block) => block.shared), expected);
        assertJoins(blocks.filter((block) => !block.shared), [[false, false]]);
    }
});

test("reordering recalculates which side of an overlapping timed copy connects", () => {
    const data = joinedData();
    data.settings.shareMode = true;
    const calendars = data.snapshot.calendars;
    calendars[1].events.push(otherTimedEvent("other", "17:55:00", "18:20:00"));
    const renderer = createRenderer();
    let shared = gridEventBlocks(renderer.render(data)).filter((block) => block.shared);
    assertJoins(shared, [[false, false], [false, true], [true, false]]);

    [calendars[1], calendars[2]] = [calendars[2], calendars[1]];
    shared = gridEventBlocks(renderer.render(data)).filter((block) => block.shared);
    assertJoins(shared, [[false, true], [true, false], [false, false]]);
});

test("simultaneous shared groups connect only where their lanes actually meet", () => {
    const data = sharedData();
    data.settings.shareMode = true;
    const [alice, bob] = data.snapshot.calendars;
    alice.events.push({ ...alice.events[0], id: "second-alice", uid: "second@example.com" });
    bob.events.unshift({ ...bob.events[0], id: "second-bob", uid: "second@example.com" });
    const renderer = createRenderer();
    let blocks = gridEventBlocks(renderer.render(data));
    assert.equal(new Set(blocks.map((block) => block.shared)).size, 2);
    assertJoins(blocks, [[false, false], [false, true], [true, false], [false, false]]);
    assert.equal(blocks[1].shared, blocks[2].shared);

    bob.events.reverse();
    blocks = gridEventBlocks(renderer.render(data));
    assertJoins(blocks, [[false, false], [false, false], [false, false], [false, false]]);
});

test("duplicate copies do not hide events or connect to a different end time", () => {
    const data = sharedData();
    data.settings.shareMode = true;
    const bob = data.snapshot.calendars[1];
    const duplicate = { ...bob.events[0], id: "duplicate", end: "2026-10-12T18:45:00" };
    bob.events.push(duplicate);
    const renderer = createRenderer();
    let blocks = gridEventBlocks(renderer.render(data));
    assert.equal(blocks.length, 3);
    assertJoins(blocks, [[false, false], [false, false], [false, false]]);

    duplicate.end = "2026-10-12T18:20:00";
    blocks = gridEventBlocks(renderer.render(data));
    assertJoins(blocks, [[false, true], [true, false], [false, false]]);
});

test("visible declined timed copies can join at an exposed edge", () => {
    const data = sharedData();
    const [alice, bob] = data.snapshot.calendars;
    alice.events[0].responseStatus = "declined";
    alice.events.unshift(otherTimedEvent("other", "17:55:00", "18:20:00"));
    data.settings.shareMode = true;
    data.settings.showDeclined = true;
    const renderer = createRenderer();
    let blocks = gridEventBlocks(renderer.render(data));
    let shared = blocks.filter((block) => block.shared);
    assertJoins(shared, [[false, true], [true, false]]);
    assert.ok(shared[0].classes.has("declined"));
    assert.match(shared[0].markup, /aria-label="18:00–18:30 予定あり 同1（辞退）"/);

    data.settings.showDeclined = false;
    blocks = gridEventBlocks(renderer.render(data));
    shared = blocks.filter((block) => block.shared);
    assert.equal(shared.length, 0);
    assert.equal(blocks.length, 2);
    assertJoins(blocks, [[false, false], [false, false]]);
    assert.equal(bob.events.length, 1);
});

test("visual blockers on the same timed edge are detected beyond the adjacent sorted event", () => {
    const data = sharedData();
    data.settings.shareMode = true;
    const bob = data.snapshot.calendars[1];
    const before = otherTimedEvent("before", "17:59:00", "18:00:00");
    const interior = otherTimedEvent("interior", "17:59:30", "18:10:00");
    bob.events.push(before, interior);
    const renderer = createRenderer();
    let blocks = gridEventBlocks(renderer.render(data));
    let shared = blocks.filter((block) => block.shared);
    assertJoins(shared, [[false, false], [false, false]]);
    assert.match(blocks[1].markup, /left:0%;width:50%/);
    assert.match(blocks[2].markup, /left:50%;width:50%/);
    assert.match(shared[1].markup, /left:0%;width:50%/);

    before.end = "2026-10-12T17:59:30";
    interior.start = "2026-10-12T18:01:00";
    blocks = gridEventBlocks(renderer.render(data));
    shared = blocks.filter((block) => block.shared);
    assertJoins(shared, [[false, false], [false, false]]);
    assert.match(blocks[1].markup, /left:0%;width:100%/);

    before.start = "2026-10-12T17:00:00";
    before.end = "2026-10-12T17:01:00";
    blocks = gridEventBlocks(renderer.render(data));
    shared = blocks.filter((block) => block.shared);
    assertJoins(shared, [[false, true], [true, false]]);
    assertJoins(blocks.filter((block) => !block.shared), [[false, false], [false, false]]);
});

test("a minimum-height block in a different cluster cannot be covered by a joined edge lane", () => {
    const data = sharedData();
    data.settings.shareMode = true;
    const [alice, bob] = data.snapshot.calendars;
    for (const calendar of [alice, bob]) {
        Object.assign(calendar.events[0], {
            start: "2026-10-12T10:00:00", end: "2026-10-12T10:30:00",
        });
    }
    alice.events.push(
        otherTimedEvent("long", "09:30:00", "10:00:00"),
        otherTimedEvent("early-one", "09:30:00", "09:30:20"),
        otherTimedEvent("early-two", "09:30:00", "09:30:20"),
        otherTimedEvent("late-interior", "09:59:00", "10:00:00"),
        otherTimedEvent("next-cluster", "10:00:00", "11:00:00"),
    );
    const blocks = gridEventBlocks(createRenderer().render(data));
    const shared = blocks.filter((block) => block.shared);
    assert.equal(blocks.length, 7);
    assert.match(shared[0].markup, /left:50%;width:50%/);
    const late = blocks.find((block) => block.markup.includes('data-share-time="09:59–10:00"'));
    assert.match(late.markup, /left:33\.33333333333333%;width:33\.333333333333336%/);
    assertJoins(shared, [[false, false], [false, false]]);
});

test("timed edge detection allows exact visual contact but rejects minimum-height overlaps", () => {
    const renderer = createRenderer();
    const nextStart = 14 * 60 / layout.HOUR_HEIGHT;
    const placements = [
        { startMin: 0, endMin: 1, lane: 0, laneCount: 1 },
        { startMin: nextStart, endMin: nextStart + 10, lane: 0, laneCount: 2 },
        { startMin: nextStart, endMin: nextStart + 10, lane: 1, laneCount: 2 },
    ];
    assert.deepEqual(renderer.timedEdges(placements, "left"), [true, true, false]);
    assert.deepEqual(renderer.timedEdges(placements, "right"), [true, false, true]);
    placements[1].startMin -= 0.01;
    placements[2].startMin -= 0.01;
    assert.deepEqual(renderer.timedEdges(placements, "left"), [false, false, false]);
    assert.deepEqual(renderer.timedEdges(placements, "right"), [false, false, false]);
});

test("timed events with logical or minimum-height visual overlaps stay separate", () => {
    for (const conflictStart of ["18:02", "18:06", "17:59"]) {
        const data = joinedData();
        data.settings.shareMode = true;
        for (const calendar of data.snapshot.calendars) {
            Object.assign(calendar.events[0], {
                start: "2026-10-12T18:00:00", end: "2026-10-12T18:05:00",
            });
        }
        data.snapshot.calendars[0].events.push({
            id: "other", uid: "other", detailsVisible: true, summary: "Other", allDay: false,
            start: `2026-10-12T${conflictStart}:00`,
            end: conflictStart === "17:59" ? "2026-10-12T18:00:00" : `2026-10-12T${conflictStart === "18:02" ? "18:04" : "18:10"}:00`,
        });
        const blocks = gridEventBlocks(createRenderer().render(data));
        const shared = blocks.filter((block) => block.shared);
        assert.equal(blocks.length, 4);
        assertJoins(shared, [[false, false], [false, true], [true, false]]);
        assertJoins(blocks.filter((block) => !block.shared), [[false, false]]);
    }
});

test("additional all-day events do not prevent same-row shared copies from connecting", () => {
    const data = joinedData(true);
    data.settings.shareMode = true;
    data.snapshot.calendars[0].events.push(otherAllDayEvent("other"));
    const html = createRenderer().render(data);
    const blocks = gridEventBlocks(html);
    const shared = blocks.filter((block) => block.shared);
    assert.equal(blocks.length, 4);
    assertJoins(shared, [[false, true], [true, true], [true, false]]);
    assertJoins(blocks.filter((block) => !block.shared), [[false, false]]);
    const rows = gridAllDayRows(html);
    assert.deepEqual(rows.map((row) => row.cells), [4, 4]);
    assert.deepEqual(rows.map((row) => row.blocks.length), [3, 1]);
});

test("later all-day rows align without moving other events or changing normal mode", () => {
    const data = joinedData(true);
    data.settings.shareMode = true;
    data.snapshot.calendars.forEach((calendar, index) => {
        calendar.events.unshift(otherAllDayEvent(`other-${index}`));
    });
    data.snapshot.calendars[2].events.push(otherAllDayEvent("extra"));
    const renderer = createRenderer();
    const html = renderer.render(data);
    const rows = gridAllDayRows(html);
    assert.deepEqual(rows.map((row) => row.cells), [4, 4, 4]);
    assert.deepEqual(rows.map((row) => row.blocks.length), [3, 3, 1]);
    assertJoins(rows[0].blocks, [[false, false], [false, false], [false, false]]);
    assertJoins(rows[1].blocks, [[false, true], [true, true], [true, false]]);
    assertJoins(rows[2].blocks, [[false, false]]);
    assert.doesNotMatch(html, /other-[012]|extra|Hidden |data-cal=|data-ev=/);

    data.settings.shareMode = false;
    const normalRows = gridAllDayRows(renderer.render(data));
    assert.equal(normalRows.length, 1);
    assert.deepEqual(normalRows[0].blocks.map((block) => block.event), [
        "other-0", "meeting-alice", "other-1", "meeting-bob", "other-2", "meeting-carol", "extra",
    ]);
    assertJoins(normalRows[0].blocks, Array.from({ length: 7 }, () => [false, false]));
});

test("all-day copies in different rows remain separate while same-row neighbors connect", () => {
    const data = joinedData(true);
    data.settings.shareMode = true;
    data.snapshot.calendars[0].events.unshift(otherAllDayEvent("other"));
    const rows = gridAllDayRows(createRenderer().render(data));
    assert.deepEqual(rows.map((row) => row.blocks.length), [4]);
    assertJoins(rows[0].blocks, [[false, false], [false, false], [false, true], [true, false]]);
});

test("hidden declined all-day events do not occupy a row or prevent a join", () => {
    const data = sharedData(true);
    const declined = { ...otherAllDayEvent("declined-other"), responseStatus: "declined" };
    data.snapshot.calendars[0].events.unshift(declined);
    data.settings.shareMode = true;
    data.settings.showDeclined = true;
    const renderer = createRenderer();
    let rows = gridAllDayRows(renderer.render(data));
    assert.deepEqual(rows.map((row) => row.blocks.length), [3]);
    assertJoins(rows[0].blocks, [[false, false], [false, false], [false, false]]);
    assert.ok(rows[0].blocks[0].classes.has("declined"));

    data.settings.showDeclined = false;
    rows = gridAllDayRows(renderer.render(data));
    assert.deepEqual(rows.map((row) => row.blocks.length), [2]);
    assertJoins(rows[0].blocks, [[false, true], [true, false]]);
    assert.strictEqual(data.snapshot.calendars[0].events[0], declined);
});

test("all-day events after the last joined row remain in one trailing list", () => {
    const data = sharedData(true);
    data.settings.shareMode = true;
    for (let index = 0; index < 30; index += 1) {
        data.snapshot.calendars[0].events.push(otherAllDayEvent(`other-${index}`));
    }
    const rows = gridAllDayRows(createRenderer().render(data));
    assert.deepEqual(rows.map((row) => row.cells), [3, 3]);
    assert.deepEqual(rows.map((row) => row.blocks.length), [2, 30]);
    assertJoins(rows[0].blocks, [[false, true], [true, false]]);
    assertJoins(rows[1].blocks, Array.from({ length: 30 }, () => [false, false]));
});

test("unjoined all-day events before a connected row remain in a single list per column", () => {
    const data = sharedData(true);
    data.settings.shareMode = true;
    for (const [calendarIndex, calendar] of data.snapshot.calendars.entries()) {
        const previous = Array.from({ length: 30 }, (_, index) =>
            otherAllDayEvent(`other-${calendarIndex}-${index}`));
        calendar.events.unshift(...previous);
    }
    const rows = gridAllDayRows(createRenderer().render(data));
    assert.deepEqual(rows.map((row) => row.cells), [3, 3]);
    assert.deepEqual(rows.map((row) => row.blocks.length), [60, 2]);
    assertJoins(rows[0].blocks, Array.from({ length: 60 }, () => [false, false]));
    assertJoins(rows[1].blocks, [[false, true], [true, false]]);
});

test("multiple all-day groups connect on their own rows without joining across days", () => {
    const data = joinedData(true);
    data.settings.shareMode = true;
    data.snapshot.range.days.push("2026-10-13");
    data.snapshot.calendars.forEach((calendar, index) => {
        calendar.events[0].end = "2026-10-14";
        calendar.events.unshift({
            ...calendar.events[0], id: `other-shared-${index}`, uid: "other-shared",
        });
        calendar.events.push({
            ...otherAllDayEvent(`other-${index}`), end: "2026-10-14",
        });
    });
    const rows = gridAllDayRows(createRenderer().render(data));
    assert.deepEqual(rows.map((row) => row.cells), [7, 7, 7]);
    assert.deepEqual(rows.map((row) => row.blocks.length), [6, 6, 6]);
    for (const row of rows.slice(0, 2)) {
        assertJoins(row.blocks, [
            [false, true], [true, true], [true, false],
            [false, true], [true, true], [true, false],
        ]);
    }
    assertJoins(rows[2].blocks, Array.from({ length: 6 }, () => [false, false]));
});

test("only connected sharing frames use rounded, indented joins", async () => {
    const css = await readFile(new URL("./ui/app.css", import.meta.url), "utf8");
    const rule = css.match(/\.ev\.sharing\.join-left,\s*\.ev\.sharing\.join-right\s*\{([^}]*)\}/)?.[1];
    assert.ok(rule);
    assert.match(rule, /border-radius:\s*14px\s*\/\s*25%\s*;/);
    assert.match(rule, /padding-inline:\s*8px\s*;/);
    assert.match(css, /^\.ev\s*\{[^}]*border-radius:\s*4px\s*;/m);
    assert.match(css, /\.ev\.join-left\s*\{\s*border-left:\s*0\s*;/);
    assert.match(css, /\.ev\.join-right\s*\{\s*border-right:\s*0\s*;/);
    assert.match(css, /table\.cal tbody > tr\.allday-row > td\s*\{\s*height:\s*1px\s*;/);
    assert.match(css, /\.allday-row:not\(\.allday-last\) \.allday\s*\{\s*border-bottom:\s*0\s*;/);
});

test("sharing mode uses dotted and hatched declined events without overriding joined edges", async () => {
    const css = await readFile(new URL("./ui/app.css", import.meta.url), "utf8");
    const sharingRule = css.match(/\.ev\.sharing\.declined\s*\{([^}]*)\}/)?.[1];
    assert.ok(sharingRule);
    assert.match(sharingRule, /border-style:\s*dotted\s*;/);
    assert.doesNotMatch(sharingRule, /(?:^|;)\s*border(?:-left|-right)?\s*:/);

    const hatchRule = css.match(/^\.ev\s*\{([^}]*)\}/m)?.[1];
    assert.ok(hatchRule);
    assert.match(hatchRule, /--ev-hatch:\s*repeating-linear-gradient\(135deg,\s*var\(--ev-fill\)\s*0 4px,\s*transparent\s*4px 8px\)/);
    assert.match(css, /\.ev\.masked\s*\{\s*background:\s*var\(--ev-hatch\)\s*;/);
    assert.match(css, /\.ev\.sharing\.declined,\s*\.ev\.sharing\.declined:hover:not\(:disabled\)\s*\{\s*background:\s*var\(--ev-hatch\)\s*;/);
    assert.match(css, /\.ev\.sharing\.declined\.join-left,\s*\.ev\.sharing\.declined\.join-right,\s*\.ev\.sharing\.declined\.join-left:hover:not\(:disabled\),\s*\.ev\.sharing\.declined\.join-right:hover:not\(:disabled\)\s*\{\s*background:\s*var\(--ev-hatch\),\s*var\(--background-color-default,\s*#ffffff\)\s*;/);
    const swatchRule = css.match(/\.swatch\.share\.declined\s*\{([^}]*)\}/)?.[1];
    assert.ok(swatchRule);
    assert.match(swatchRule, /background:\s*repeating-linear-gradient\(135deg,/);

    const normalRule = css.match(/\.ev\.declined:not\(\.sharing\)\s*\{([^}]*)\}/)?.[1];
    assert.ok(normalRule);
    assert.match(normalRule, /opacity:\s*0\.55\s*;/);
    assert.match(normalRule, /text-decoration:\s*line-through\s*;/);

    const html = await readFile(new URL("./ui/index.html", import.meta.url), "utf8");
    assert.match(html, /class="swatch share declined"><\/i>辞退（点線・斜線）/);
});

test("visible declined copies match the same event without changing the snapshot", () => {
    for (const allDay of [false, true]) {
        for (const sharing of [false, true]) {
            const data = sharedData(allDay);
            const [alice, bob] = data.snapshot.calendars;
            alice.events[0].id = "accepted-copy";
            bob.events[0].id = "declined-copy";
            bob.events[0].responseStatus = "declined";
            data.settings.shareMode = sharing;
            data.settings.showDeclined = false;
            const renderer = createRenderer();
            const originalEvents = [alice.events, bob.events];

            let blocks = gridEventBlocks(renderer.render(data));
            assert.equal(blocks.length, 1);
            assert.equal(blocks[0].shared, undefined);
            assertJoins(blocks, [[false, false]]);

            data.settings.showDeclined = true;
            const html = renderer.render(data);
            blocks = gridEventBlocks(html);
            assert.equal(blocks.length, 2);
            assert.deepEqual(blocks.map((block) => block.shared), ["1", "1"]);
            assert.deepEqual(blocks.map((block) => block.classes.has("declined")), [false, true]);
            assertJoins(blocks, sharing ? [[false, true], [true, false]] : [[false, false], [false, false]]);
            if (sharing) {
                const colors = blocks.map((block) => /--ev-color:([^;"]+)/.exec(block.markup)[1]);
                assert.equal(colors[0], colors[1]);
                const time = allDay ? "終日" : "18:00–18:30";
                assert.ok(blocks[0].markup.includes(`aria-label="${time} 予定あり 同1"`));
                assert.ok(blocks[1].markup.includes(`aria-label="${time} 予定あり 同1（辞退）"`));
                assert.ok(blocks[1].markup.includes(`title="${time} 予定あり 同1（辞退）"`));
                assert.doesNotMatch(html, /accepted-copy|declined-copy|meeting@example\.com|Hidden private summary|data-cal=|data-ev=/);
            } else {
                assert.equal(blocks[1].event, "declined-copy");
                assert.ok(blocks[1].classes.has("declined"));
                assert.match(renderer.details(alice.events[0], alice), /Bob &quot;&lt;&amp;&gt;/);
                assert.match(renderer.details(bob.events[0], bob), /参加状況<\/dt><dd>辞退/);
            }

            data.settings.showDeclined = false;
            blocks = gridEventBlocks(renderer.render(data));
            assert.equal(blocks.length, 1);
            assert.equal(blocks[0].shared, undefined);
            assert.strictEqual(alice.events, originalEvents[0]);
            assert.strictEqual(bob.events, originalEvents[1]);
            assert.equal(bob.events[0].responseStatus, "declined");
        }
    }
});

test("sharing mode marks only each declined copy in connected three-member groups", () => {
    for (const allDay of [false, true]) {
        for (const declinedIndex of [0, 1, 2]) {
            const data = joinedData(allDay);
            data.settings.shareMode = true;
            data.settings.showDeclined = true;
            data.snapshot.calendars.forEach((calendar, index) => {
                calendar.events[0].responseStatus = index === declinedIndex ? "declined" : "accepted";
            });
            const blocks = gridEventBlocks(createRenderer().render(data));
            const time = allDay ? "終日" : "18:00–18:30";
            assert.equal(blocks.length, 3);
            assert.deepEqual(blocks.map((block) => block.shared), ["1", "1", "1"]);
            assertJoins(blocks, [[false, true], [true, true], [true, false]]);
            assert.equal(new Set(blocks.map((block) => /--ev-color:([^;"]+)/.exec(block.markup)[1])).size, 1);
            blocks.forEach((block, index) => {
                const suffix = index === declinedIndex ? "（辞退）" : "";
                assert.equal(block.classes.has("declined"), index === declinedIndex);
                assert.ok(block.markup.includes(`aria-label="${time} 予定あり 同1${suffix}"`));
                assert.ok(block.markup.includes(`title="${time} 予定あり 同1${suffix}"`));
                assert.doesNotMatch(block.markup, /meeting-(?:alice|bob|carol)|meeting@example\.com|Hidden private summary|data-cal=|data-ev=/);
            });
        }
    }
});

test("sharing mode marks an unshared declined event without exposing details", () => {
    for (const allDay of [false, true]) {
        const data = sharedData(allDay);
        data.snapshot.calendars.pop();
        data.snapshot.calendars[0].events[0].responseStatus = "declined";
        data.settings.shareMode = true;
        data.settings.showDeclined = true;
        const blocks = gridEventBlocks(createRenderer().render(data));
        const time = allDay ? "終日" : "18:00–18:30";
        assert.equal(blocks.length, 1);
        assert.equal(blocks[0].shared, undefined);
        assert.ok(blocks[0].classes.has("sharing"));
        assert.ok(blocks[0].classes.has("declined"));
        assertJoins(blocks, [[false, false]]);
        assert.ok(blocks[0].markup.includes(`aria-label="${time} 予定あり（辞退）"`));
        assert.ok(blocks[0].markup.includes(`title="${time} 予定あり（辞退）"`));
        assert.doesNotMatch(blocks[0].markup, /meeting@example\.com|Hidden private summary|data-cal=|data-ev=/);
    }
});

test("two displayed declined copies still represent the same invitation", () => {
    for (const allDay of [false, true]) {
        const data = sharedData(allDay);
        data.settings.showDeclined = true;
        data.settings.shareMode = true;
        for (const calendar of data.snapshot.calendars) calendar.events[0].responseStatus = "declined";
        const blocks = gridEventBlocks(createRenderer().render(data));
        assert.deepEqual(blocks.map((block) => block.shared), ["1", "1"]);
        assert.deepEqual(blocks.map((block) => block.classes.has("declined")), [true, true]);
        assertJoins(blocks, [[false, true], [true, false]]);
    }
});

test("a hidden declined copy cannot bridge otherwise separate event identities", () => {
    const data = joinedData();
    const [alice, bob, carol] = data.snapshot.calendars;
    Object.assign(alice.events[0], { id: "alice-copy", uid: "invitation" });
    Object.assign(bob.events[0], { id: "bob-copy", uid: "bob-copy" });
    Object.assign(carol.events[0], { id: "bob-copy", uid: "invitation", responseStatus: "declined" });
    data.settings.shareMode = true;
    data.settings.showDeclined = false;
    const renderer = createRenderer();

    let blocks = gridEventBlocks(renderer.render(data));
    assert.deepEqual(blocks.map((block) => block.shared), [undefined, undefined]);
    assertJoins(blocks, [[false, false], [false, false]]);

    data.settings.showDeclined = true;
    blocks = gridEventBlocks(renderer.render(data));
    assert.deepEqual(blocks.map((block) => block.shared), ["1", "1", "1"]);
    assertJoins(blocks, [[false, true], [true, true], [true, false]]);
});

function sharingData() {
    const shared = {
        id: "SECRET_ID_A", uid: "SECRET_UID", summary: "SECRET_TITLE", detailsVisible: true, allDay: false,
        start: "2026-10-12T09:00:00", end: "2026-10-12T10:00:00",
        location: "SECRET_LOCATION", organizer: "SECRET_ORGANIZER", description: "SECRET_DESCRIPTION",
        completed: true, completedFrom: "SECRET_SOURCE", completedFromName: "SECRET_SOURCE_NAME",
        transparency: "transparent", responseStatus: "accepted",
    };
    const allDay = {
        ...shared, id: "SECRET_ALLDAY_A", uid: "SECRET_ALLDAY_UID", summary: "SECRET_ALLDAY_TITLE",
        allDay: true, start: "2026-10-12", end: "2026-10-13",
    };
    const solo = {
        ...shared, id: "SECRET_SOLO_ID", uid: "SECRET_SOLO_UID", summary: "SECRET_SOLO_TITLE",
        start: "2026-10-12T11:00:00", end: "2026-10-12T11:30:00",
        detailsVisible: false, responseStatus: "declined",
    };
    const calendars = [
        {
            id: "alice", label: "Alice", color: "#3f7ee8", error: null,
            stats: { total: 3, hidden: 1, declined: 1 }, events: [shared, allDay, solo],
        },
        {
            id: "bob", label: "Bob", color: "#c9631a", error: null,
            stats: { total: 2, hidden: 0, declined: 0 },
            events: [{ ...shared, id: "SECRET_ID_B" }, { ...allDay, id: "SECRET_ALLDAY_B" }],
        },
    ];
    const scan = {
        fetchedAt: "2026-10-12T00:00:00Z", from: "2026-10-12", until: "2026-10-18",
        durationMinutes: 30, totalFreeSlots: 1,
        hint: ["SECRET_HINT"],
        candidates: [{
            day: "2026-10-12", start: "10:00", end: "10:30", blockMinutes: 30,
            reasons: ["SECRET_REASON"],
        }],
        blockers: [{ label: "Alice", slotsBlocked: 2, soleBlocker: 1, awaySlots: 1 }],
        nearMiss: [{
            day: "2026-10-12", start: "11:00", end: "11:30", blocker: "Alice", movable: false,
            events: [{ title: "SECRET_NEAR", kind: "away" }],
        }],
        sharedMeetings: [{
            title: "SECRET_SHARED", attendees: ["Alice", "Bob"], attendeeCount: 2,
            recurring: true, occurrences: 2, firstStart: "2026-10-12T09:00:00", keys: ["SECRET_KEY"],
        }],
        calendars: [{ id: "alice" }, { id: "bob" }],
    };
    return {
        profile: "sharing-test", revision: 1,
        settings: {
            calendars: calendars.map(({ id, label }) => ({ id, label })),
            refs: [], view: "day", workStart: "09:00", workEnd: "18:00",
            showDeclined: true, showCompletionDiff: true, policyPatterns: ["SECRET_POLICY"],
        },
        snapshot: { calendars, range: { days: ["2026-10-12"] }, fetchedAt: "2026-10-12T00:00:00Z" },
        range: { anchor: "2026-10-12", days: ["2026-10-12"] },
        presets: [], freeSlots: [], scan,
    };
}

test("declined visibility rebuilds grouping and joins without fetching or changing the snapshot", async () => {
    const data = sharingData();
    data.settings.shareMode = true;
    data.settings.showDeclined = false;
    data.snapshot.calendars[1].events[0].responseStatus = "declined";
    const renderer = createRenderer();
    renderer.apply(data);
    const timedBlocks = () => gridEventBlocks(renderer.element("grid").innerHTML)
        .filter((block) => block.markup.includes('data-share-time="09:00–10:00"'));
    let blocks = timedBlocks();
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].shared, undefined);

    const requests = [];
    let revision = data.revision;
    renderer.useFetch(async (url, options) => {
        const request = JSON.parse(options.body);
        requests.push({ route: new URL(url, "http://localhost").pathname, body: request });
        return {
            ok: true,
            json: async () => ({
                ...data, revision: ++revision,
                settings: { ...data.settings, ...request.settings },
            }),
        };
    });

    renderer.element("show-declined").checked = true;
    await renderer.fire("show-declined", "change");
    blocks = timedBlocks();
    assert.equal(blocks.length, 2);
    assert.deepEqual(blocks.map((block) => block.shared), ["2", "2"]);
    assert.deepEqual(blocks.map((block) => block.classes.has("declined")), [false, true]);
    assertJoins(blocks, [[false, true], [true, false]]);
    assert.strictEqual(renderer.data().snapshot, data.snapshot);

    renderer.element("show-declined").checked = false;
    await renderer.fire("show-declined", "change");
    blocks = timedBlocks();
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].shared, undefined);
    assert.strictEqual(renderer.data().snapshot, data.snapshot);
    assert.deepEqual(requests, [
        { route: "/api/settings", body: { settings: { showDeclined: true }, refresh: false } },
        { route: "/api/settings", body: { settings: { showDeclined: false }, refresh: false } },
    ]);
});

test("sharing mode anonymizes timed and all-day events and colors matching groups", () => {
    const renderer = createRenderer();
    const data = sharingData();
    data.settings.shareMode = true;
    renderer.apply(data);
    const html = renderer.element("grid").innerHTML;
    for (const secret of [
        "SECRET_ID", "SECRET_UID", "SECRET_ALLDAY", "SECRET_SOLO", "SECRET_TITLE", "SECRET_LOCATION",
        "SECRET_ORGANIZER", "SECRET_DESCRIPTION", "SECRET_SOURCE",
    ]) assert.ok(!html.includes(secret), secret);
    assert.match(html, /Alice/);
    assert.match(html, /Bob/);
    assert.doesNotMatch(html, /data-cal=|data-ev=|class="badge"|class="ev[^"]*(?:masked|transparent)/);
    const declined = gridEventBlocks(html).filter((block) => block.classes.has("declined"));
    assert.equal(declined.length, 1);
    assert.match(declined[0].markup, /aria-label="11:00–11:30 予定あり（辞退）"/);

    const blocks = [...html.matchAll(/<button type="button" class="ev sharing[^"]*"[\s\S]*?<\/button>/g)]
        .map((match) => match[0]);
    assert.equal(blocks.length, 5);
    const groups = new Map();
    let ordinary = 0;
    for (const block of blocks) {
        assert.match(block, /aria-label="(?:終日|\d\d:\d\d–\d\d:\d\d) 予定あり/);
        assert.match(block, /title="(?:終日|\d\d:\d\d–\d\d:\d\d) 予定あり/);
        const color = /--ev-color:([^;"]+)/.exec(block)[1];
        const number = /data-shared="(\d+)"/.exec(block)?.[1];
        if (number) {
            if (!groups.has(number)) groups.set(number, []);
            groups.get(number).push(color);
            assert.match(block, new RegExp(`>同${number}</span>`));
        } else {
            ordinary += 1;
            assert.equal(color, "#6e7781");
            assert.match(block, /予定あり/);
        }
    }
    assert.equal(ordinary, 1);
    assert.equal(groups.size, 2);
    const colors = [...groups.values()].map((values) => {
        assert.equal(values.length, 2);
        assert.equal(new Set(values).size, 1);
        return values[0];
    });
    assert.equal(new Set(colors).size, 2);
    assert.equal(renderer.element("normal-legend").hidden, true);
    assert.equal(renderer.element("share-legend").hidden, false);
    assert.equal(renderer.element("policy-pattern-field").hidden, true);
    assert.doesNotMatch(renderer.element("chips").innerHTML, /非公開|辞退|3 件|2 件/);
});

test("sharing mode removes event details from popovers and every adjustment pane", () => {
    const renderer = createRenderer();
    const data = sharingData();
    renderer.apply(data);
    const original = renderer.details(data.snapshot.calendars[0].events[0], data.snapshot.calendars[0]);
    assert.match(original, /SECRET_TITLE|SECRET_DESCRIPTION/);

    renderer.apply({ ...data, revision: 2, settings: { ...data.settings, shareMode: true } });
    assert.equal(renderer.element("popover").hidden, true);
    assert.equal(renderer.element("popover").innerHTML, "");
    const details = renderer.sharingDetails("09:00–10:00", 2);
    assert.match(details, /予定あり/);
    assert.match(details, /09:00–10:00/);
    assert.match(details, /同2/);
    assert.doesNotMatch(details, /参加状況|辞退/);
    const declinedDetails = renderer.sharingDetails("終日", 2, true);
    assert.match(declinedDetails, /<dt>参加状況<\/dt><dd>辞退<\/dd>/);
    for (const id of ["tab-candidates", "tab-blockers", "tab-shared", "popover"]) {
        assert.doesNotMatch(renderer.element(id).innerHTML, /SECRET_/);
    }
    assert.match(renderer.element("tab-blockers").innerHTML, /Alice/);
    assert.match(renderer.element("tab-shared").innerHTML, /Alice・Bob/);
    assert.doesNotMatch(renderer.element("tab-blockers").innerHTML, /immovable|movable|終日ブロック/);
    assert.doesNotMatch(renderer.element("tab-shared").innerHTML, />定期<|2回/);

    renderer.apply({ ...data, revision: 3, settings: { ...data.settings, shareMode: true } });
    assert.equal(renderer.element("popover").innerHTML, "");
    renderer.details(data.snapshot.calendars[0].events[0], data.snapshot.calendars[0]);
    assert.equal(renderer.element("popover").innerHTML, "");
});

test("sharing mode switches immediately, survives stale updates, and requires local disclosure", async () => {
    const renderer = createRenderer();
    const initial = sharingData();
    renderer.apply(initial);
    assert.equal(gridEventBlocks(renderer.element("grid").innerHTML).some((block) => block.classes.has("join-right")), false);
    renderer.details(initial.snapshot.calendars[0].events[0], initial.snapshot.calendars[0]);
    let release;
    const requests = [];
    renderer.useFetch((url, options) => {
        requests.push({ route: new URL(url, "http://localhost").pathname, body: JSON.parse(options.body) });
        return new Promise((resolve) => { release = resolve; });
    });

    const enabling = renderer.fire("toggle-share", "click");
    assert.equal(renderer.element("toggle-share").getAttribute("aria-pressed"), "true");
    assert.equal(renderer.element("toggle-share").disabled, true);
    assert.equal(renderer.element("popover").innerHTML, "");
    assert.doesNotMatch(renderer.element("grid").innerHTML, /SECRET_TITLE/);
    assert.equal(gridEventBlocks(renderer.element("grid").innerHTML).some((block) => block.classes.has("join-right")), true);
    let declined = gridEventBlocks(renderer.element("grid").innerHTML).find((block) => block.markup.includes('data-share-time="11:00–11:30"'));
    assert.ok(declined.classes.has("sharing") && declined.classes.has("declined"));
    assert.match(declined.markup, /aria-label="11:00–11:30 予定あり（辞退）"/);
    renderer.apply({ ...initial, revision: 2 });
    assert.doesNotMatch(renderer.element("grid").innerHTML, /SECRET_TITLE/);
    const enabled = { ...initial, revision: 3, settings: { ...initial.settings, shareMode: true } };
    release({ ok: true, json: async () => enabled });
    await enabling;
    assert.deepEqual(requests[0], {
        route: "/api/settings", body: { settings: { shareMode: true }, refresh: false },
    });

    const externallyDisabled = { ...initial, revision: 4, settings: { ...initial.settings, shareMode: false } };
    renderer.apply(externallyDisabled);
    assert.equal(renderer.element("toggle-share").getAttribute("aria-pressed"), "true");
    assert.match(renderer.element("share-mode-error-text").textContent, /再読込すると表示されます/);
    assert.equal(renderer.element("retry-share-mode").hidden, true);
    assert.doesNotMatch(renderer.element("grid").innerHTML, /SECRET_TITLE/);
    assert.equal(gridEventBlocks(renderer.element("grid").innerHTML).some((block) => block.classes.has("join-right")), true);
    declined = gridEventBlocks(renderer.element("grid").innerHTML).find((block) => block.markup.includes('data-share-time="11:00–11:30"'));
    assert.ok(declined.classes.has("sharing") && declined.classes.has("declined"));

    const disabling = renderer.fire("toggle-share", "click");
    renderer.apply({ ...enabled, revision: 6 });
    release({ ok: true, json: async () => ({ ...externallyDisabled, revision: 5 }) });
    await disabling;
    assert.equal(renderer.element("toggle-share").getAttribute("aria-pressed"), "true");
    assert.equal(renderer.element("share-mode-error").hidden, false);
    assert.doesNotMatch(renderer.element("grid").innerHTML, /SECRET_TITLE/);
    renderer.apply({ ...enabled, revision: 7 });
    assert.equal(renderer.element("share-mode-error").hidden, false);

    renderer.useFetch(async () => ({
        ok: true, json: async () => ({ ...externallyDisabled, revision: 8 }),
    }));
    await renderer.fire("retry-share-mode", "click");
    assert.equal(renderer.element("toggle-share").getAttribute("aria-pressed"), "false");
    assert.equal(renderer.element("share-mode-error").hidden, true);
    assert.match(renderer.element("grid").innerHTML, /SECRET_TITLE/);
    assert.equal(gridEventBlocks(renderer.element("grid").innerHTML).some((block) => block.classes.has("join-right")), false);
    assert.match(renderer.element("tab-candidates").innerHTML, /SECRET_REASON/);
    assert.equal(renderer.element("policy-pattern-field").hidden, false);
});

test("a latched sharing mode keeps multi-row all-day joins anonymous after a failed save", async () => {
    const renderer = createRenderer();
    const data = sharingData();
    data.snapshot.calendars[0].events.push(otherAllDayEvent("SECRET_EXTRA"));
    renderer.apply(data);
    renderer.useFetch(async () => ({ ok: false, json: async () => ({ error: "SECRET_SAVE_ERROR" }) }));
    await renderer.fire("toggle-share", "click");

    let html = renderer.element("grid").innerHTML;
    let rows = gridAllDayRows(html);
    assert.equal(renderer.element("toggle-share").getAttribute("aria-pressed"), "true");
    assert.deepEqual(rows.map((row) => row.blocks.length), [2, 1]);
    assertJoins(rows[0].blocks, [[false, true], [true, false]]);
    assert.doesNotMatch(html, /SECRET_|data-cal=|data-ev=/);

    renderer.apply({ ...data, revision: 2, settings: { ...data.settings, shareMode: false } });
    html = renderer.element("grid").innerHTML;
    rows = gridAllDayRows(html);
    assert.deepEqual(rows.map((row) => row.blocks.length), [2, 1]);
    assertJoins(rows[0].blocks, [[false, true], [true, false]]);
    assert.doesNotMatch(html, /SECRET_|data-cal=|data-ev=/);
});

test("a failed sharing save stays masked and can be retried", async () => {
    const renderer = createRenderer();
    const data = sharingData();
    renderer.apply(data);
    renderer.useFetch(async () => ({ ok: false, json: async () => ({ error: "SECRET_SAVE_ERROR" }) }));
    await renderer.fire("toggle-share", "click");
    assert.equal(renderer.element("toggle-share").getAttribute("aria-pressed"), "true");
    assert.equal(renderer.element("share-mode-error").hidden, false);
    assert.match(renderer.element("share-mode-error-text").textContent, /再読込後は解除される可能性/);
    assert.doesNotMatch(renderer.element("share-mode-error-text").textContent, /SECRET_SAVE_ERROR/);
    assert.doesNotMatch(renderer.element("grid").innerHTML, /SECRET_TITLE/);

    renderer.useFetch(async () => ({
        ok: true, json: async () => ({ ...data, revision: 2, settings: { ...data.settings, shareMode: true } }),
    }));
    await renderer.fire("retry-share-mode", "click");
    assert.equal(renderer.element("share-mode-error").hidden, true);
    assert.equal(renderer.element("toggle-share").getAttribute("aria-pressed"), "true");
});

test("external sharing activation cancels dragging and redacts current and delayed errors", async () => {
    const renderer = createRenderer();
    const data = sharingData();
    data.error = "SECRET_STATUS_ERROR";
    data.presetError = "SECRET_PRESET_ERROR";
    data.snapshot.calendars[1].error = "SECRET_CALENDAR_ERROR";
    renderer.apply(data);
    renderer.element("date-picker-error").textContent = "SECRET_OLD_ERROR";
    renderer.element("calendar-hint").textContent = "SECRET_OLD_ERROR";
    renderer.details(data.snapshot.calendars[0].events[0], data.snapshot.calendars[0]);
    const classes = new Set();
    const header = {
        dataset: { orderCalendar: "alice" },
        closest(selector) { return selector === "#grid th[data-order-calendar]" ? this : null; },
        classList: { add(name) { classes.add(name); }, remove(name) { classes.delete(name); } },
    };
    renderer.dispatch("dragstart", header, null, { dataTransfer: { setData() {} } });
    assert.ok(classes.has("dragging"));
    let reject;
    renderer.useFetch(() => new Promise((resolve, fail) => { reject = fail; }));
    const move = {
        dataset: { moveCalendar: "alice", direction: "right" },
        closest(selector) { return selector === "[data-move-calendar]" ? this : null; },
    };
    renderer.dispatch("click", move);
    await Promise.resolve();

    renderer.apply({ ...data, revision: 2, settings: { ...data.settings, shareMode: true } });
    assert.ok(!classes.has("dragging"));
    assert.equal(renderer.element("popover").innerHTML, "");
    for (const id of ["grid", "chips", "status", "preset-store-error", "date-picker-error", "calendar-hint"]) {
        assert.doesNotMatch(`${renderer.element(id).innerHTML} ${renderer.element(id).textContent}`, /SECRET_/);
    }
    reject(new Error("SECRET_DELAYED_ERROR"));
    await renderer.waitForOrder();
    assert.match(renderer.element("calendar-order-message").textContent, /失敗/);
    assert.doesNotMatch(renderer.element("calendar-order-message").textContent, /SECRET_/);
});

test("matching private timed and all-day events have visible leading badges and reciprocal peer details", () => {
    for (const allDay of [false, true]) {
        const renderer = createRenderer();
        const data = sharedData(allDay);
        const [alice, bob] = data.snapshot.calendars;
        const html = renderer.render(data);
        assert.equal([...html.matchAll(/data-shared="1"/g)].length, 2);
        assert.equal([...html.matchAll(/>同1<\/span>/g)].length, 2);
        assert.ok(!html.includes("Hidden private summary"));
        for (const owner of [alice, bob]) {
            const markup = renderer.eventMarkup(owner.events[0], owner, data.settings);
            assert.match(markup, /class="ev masked"/);
            assert.match(markup, /class="shared-badge"[^>]*>同1<\/span>(?:<span class="t">.*?<\/span> )?予定あり（詳細非公開）/);
            assert.ok(markup.includes("予定 ID / iCalUID・開始時刻が一致"));
            const peerName = owner === alice ? "Bob &quot;&lt;&amp;&gt;" : "Alice";
            assert.ok(markup.includes(`: ${peerName}`));
            assert.ok(markup.includes('aria-label="同1'));
            const details = renderer.details(owner.events[0], owner);
            assert.ok(details.includes(`<dt>他のカレンダー</dt><dd>${peerName}</dd>`));
            assert.ok(details.includes("<dt>同じ予定</dt>"));
            assert.ok(!details.includes("Hidden private summary"));
            assert.ok(!details.includes(bob.label));
        }
    }
});

test("a readable matching copy does not reveal its title on the private copy", () => {
    const renderer = createRenderer();
    const data = sharedData();
    const [alice, bob] = data.snapshot.calendars;
    bob.events[0] = { ...bob.events[0], summary: "Readable peer title", detailsVisible: true };
    assert.ok(renderer.render(data).includes("Readable peer title"));
    const privateMarkup = renderer.eventMarkup(alice.events[0], alice, data.settings);
    assert.ok(privateMarkup.includes(">同1</span>"));
    assert.ok(!privateMarkup.includes("Readable peer title"));
    assert.ok(!renderer.details(alice.events[0], alice).includes("Readable peer title"));
});

test("minimum-height timed events use compact shared badges", () => {
    const data = sharedData();
    for (const calendar of data.snapshot.calendars) calendar.events[0].end = "2026-10-12T18:15:00";
    const html = createRenderer().render(data);
    assert.equal([...html.matchAll(/class="ev masked compact(?: join-(?:left|right))?"/g)].length, 2);
    assert.equal([...html.matchAll(/height:14px/g)].length, 2);
    assert.equal([...html.matchAll(/>同1<\/span>/g)].length, 2);
});

test("shared markers coexist with completion badges and clear when a peer is removed", () => {
    const renderer = createRenderer();
    const data = sharedData();
    const [alice, bob] = data.snapshot.calendars;
    const event = alice.events[0];
    Object.assign(event, { completed: true, completedFrom: "reference", completedFromName: "Reference" });
    renderer.render(data);
    let markup = renderer.eventMarkup(event, alice, { ...data.settings, showCompletionDiff: true });
    assert.ok(markup.includes(">同1</span>"));
    assert.ok(markup.includes(">補</span>"));
    markup = renderer.eventMarkup(event, alice, data.settings);
    assert.ok(markup.includes(">同1</span>"));
    assert.ok(!markup.includes('class="badge"'));
    bob.events[0].responseStatus = "declined";
    renderer.render({ ...data, settings: { ...data.settings, showDeclined: true } });
    assert.ok(renderer.eventMarkup(event, alice, data.settings).includes('class="shared-badge"'));
    renderer.render({ ...data, settings: { ...data.settings, showDeclined: false } });
    assert.ok(!renderer.eventMarkup(event, alice, data.settings).includes('class="shared-badge"'));
    bob.events[0].responseStatus = "";
    renderer.render(data);
    assert.ok(renderer.eventMarkup(event, alice, data.settings).includes('class="shared-badge"'));
    renderer.render({
        settings: { ...data.settings, calendars: [alice] },
        snapshot: { ...data.snapshot, calendars: [alice] },
    });
    assert.ok(!renderer.eventMarkup(event, alice, data.settings).includes("data-shared"));
    assert.ok(!renderer.details(event, alice).includes("<dt>他のカレンダー</dt>"));
});

test("pointer and keyboard interaction highlights only the matching group", () => {
    const renderer = createRenderer();
    const alice = renderer.block("alice", "a", 1);
    const bob = renderer.block("bob", "a", 1);
    const otherAlice = renderer.block("alice", "b", 2);
    const otherBob = renderer.block("bob", "b", 2);
    const child = { closest() { return alice; } };

    renderer.dispatch("pointerover", child);
    assert.deepEqual(renderer.highlighted(), [alice, bob]);
    renderer.dispatch("pointerout", alice, child);
    assert.deepEqual(renderer.highlighted(), [alice, bob]);
    renderer.dispatch("pointerout", child, otherAlice);
    assert.deepEqual(renderer.highlighted(), [otherAlice, otherBob]);
    renderer.dispatch("pointerout", otherAlice);
    assert.deepEqual(renderer.highlighted(), []);
    renderer.dispatch("focusin", bob);
    assert.deepEqual(renderer.highlighted(), [alice, bob]);
    renderer.dispatch("focusout", bob, otherAlice);
    assert.deepEqual(renderer.highlighted(), [otherAlice, otherBob]);
    renderer.dispatch("focusout", otherAlice);
    assert.deepEqual(renderer.highlighted(), []);

    renderer.dispatch("focusin", alice);
    renderer.dispatch("pointerover", otherBob);
    assert.deepEqual(renderer.highlighted(), [otherAlice, otherBob]);
    renderer.dispatch("pointerout", otherBob);
    assert.deepEqual(renderer.highlighted(), [alice, bob]);
    renderer.dispatch("focusout", alice);
    assert.deepEqual(renderer.highlighted(), []);

    const ordinary = renderer.block("alice", "ordinary");
    renderer.dispatch("pointerover", ordinary);
    renderer.dispatch("focusin", alice);
    assert.deepEqual(renderer.highlighted(), [alice, bob]);
    renderer.dispatch("pointerover", otherAlice);
    assert.deepEqual(renderer.highlighted(), [otherAlice, otherBob]);
    renderer.dispatch("focusin", bob);
    assert.deepEqual(renderer.highlighted(), [alice, bob]);
    renderer.dispatch("focusout", bob);
    assert.deepEqual(renderer.highlighted(), []);
});

test("member presets can be saved, selected, applied, updated and deleted from the canvas", async () => {
    const renderer = createRenderer();
    const alice = { id: "alice@example.com", label: "Alice" };
    const bob = { id: "bob@example.com", label: "Bob" };
    const calls = [];
    let data = { settings: { calendars: [alice], workStart: "09:00" }, presets: [], presetError: null };
    renderer.setData(data);
    renderer.usePresetFetch(async (url, options) => {
        const route = new URL(url, "http://localhost").pathname;
        const body = JSON.parse(options.body);
        calls.push({ route, body });
        let preset;
        if (route.endsWith("/create")) {
            preset = { id: "first", name: body.name, calendars: data.settings.calendars };
            data = { ...data, presets: [...data.presets, preset] };
        } else if (route.endsWith("/apply")) {
            preset = data.presets.find((entry) => entry.id === body.id);
            data = { ...data, settings: { ...data.settings, calendars: preset.calendars } };
        } else if (route.endsWith("/update")) {
            const previous = data.presets.find((entry) => entry.id === body.id);
            preset = { ...previous, id: "updated", calendars: data.settings.calendars };
            data = { ...data, presets: [preset] };
        } else if (route.endsWith("/delete")) {
            preset = data.presets.find((entry) => entry.id === body.id);
            data = { ...data, presets: data.presets.filter((entry) => entry.id !== body.id) };
        } else {
            throw new Error(`unexpected route: ${route}`);
        }
        return { ok: true, json: async () => ({ ...data, preset }) };
    });

    assert.equal(renderer.element("save-preset").disabled, true);
    renderer.element("preset-name").value = 'Team "<&>';
    await renderer.fire("preset-name", "input");
    assert.equal(renderer.element("save-preset").disabled, false);
    await renderer.fire("save-preset", "click");
    assert.deepEqual(calls[0], { route: "/api/presets/create", body: { name: 'Team "<&>' } });
    assert.match(renderer.element("preset-select").innerHTML, /Team &quot;&lt;&amp;&gt;/);
    assert.equal(renderer.element("preset-select").value, "first");
    assert.equal(renderer.element("preset-summary").textContent, 'Team "<&>: Alice');

    data = { ...data, settings: { ...data.settings, calendars: [bob] } };
    renderer.setData(data);
    await renderer.fire("apply-preset", "click");
    assert.deepEqual(calls[1], { route: "/api/presets/apply", body: { id: "first" } });
    assert.deepEqual(data.settings.calendars, [alice]);
    assert.equal(data.settings.workStart, "09:00");

    data = { ...data, settings: { ...data.settings, calendars: [bob] } };
    renderer.setData(data);
    await renderer.fire("update-preset", "click");
    assert.deepEqual(calls[2], { route: "/api/presets/update", body: { id: "first" } });
    assert.equal(renderer.element("preset-select").value, "updated");
    assert.equal(renderer.element("preset-summary").textContent, 'Team "<&>: Bob');

    await renderer.fire("delete-preset", "click");
    assert.equal(renderer.element("preset-delete-confirm").hidden, false);
    await renderer.fire("cancel-delete-preset", "click");
    assert.equal(renderer.element("preset-delete-confirm").hidden, true);
    assert.equal(calls.length, 3);
    await renderer.fire("delete-preset", "click");
    await renderer.fire("confirm-delete-preset", "click");
    assert.deepEqual(calls[3], { route: "/api/presets/delete", body: { id: "updated" } });
    assert.deepEqual(data.presets, []);
    assert.deepEqual(data.settings.calendars, [bob]);
});

test("preset save errors remain visible and preserve the entered name", async () => {
    const renderer = createRenderer();
    const data = { settings: { calendars: [{ id: "alice", label: "" }] }, presets: [], presetError: null };
    renderer.setData(data);
    renderer.usePresetFetch(async () => ({ ok: false, json: async () => ({ error: "保存に失敗しました" }) }));
    renderer.element("preset-name").value = "Team";
    await renderer.fire("preset-name", "input");
    await renderer.fire("save-preset", "click");
    assert.equal(renderer.element("preset-name").value, "Team");
    assert.equal(renderer.element("preset-message").hidden, false);
    assert.match(renderer.element("preset-message").textContent, /保存に失敗しました/);
    assert.equal(renderer.element("save-preset").disabled, false);
});
