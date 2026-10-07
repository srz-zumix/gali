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

function createRenderer() {
    const elements = new Map();
    const listeners = new Map();
    const blocks = [];
    const context = createContext({
        ...layout,
        ...meetings,
        document: {
            addEventListener(type, handler) {
                if (!listeners.has(type)) listeners.set(type, []);
                listeners.get(type).push(handler);
            },
            getElementById(id) {
                if (!elements.has(id)) {
                    elements.set(id, {
                        innerHTML: "",
                        style: {},
                        addEventListener() {},
                        querySelector() { return null; },
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
        dispatch(type, target, relatedTarget = null) {
            for (const listener of listeners.get(type) || []) listener({ target, relatedTarget });
        },
        highlighted() {
            return blocks.filter((block) => block.classList.contains("peer-highlight"));
        },
    };
}

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
