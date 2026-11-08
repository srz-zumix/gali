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
    for (const weekday of ["月", "火", "水", "木", "金", "土", "日"]) {
        assert.match(html, new RegExp(`<th scope="col" abbr="${weekday}曜日">${weekday}</th>`));
    }
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
    assert.match(markup, /^<tr>(?:<td role="presentation"><\/td>){6}<td role="gridcell"[^>]*><button[^>]+data-picker-date="2026-03-01"/);

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
    assert.equal(focusedCalendarDate(renderer), "2024-02-26");
    await calendarKey(renderer, "End");
    assert.equal(focusedCalendarDate(renderer), "2024-03-03");
    await calendarKey(renderer, "PageUp");
    assert.equal(focusedCalendarDate(renderer), "2024-02-03");
    await calendarKey(renderer, "PageDown", true);
    assert.equal(focusedCalendarDate(renderer), "2025-02-03");
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
    assert.equal([...html.matchAll(/class="ev masked compact"/g)].length, 2);
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
