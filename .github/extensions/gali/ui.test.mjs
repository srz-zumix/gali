import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createContext, Script } from "node:vm";

import * as layout from "./ui/layout.mjs";

const source = await readFile(new URL("./ui/app.js", import.meta.url), "utf8");
const script = new Script(source.replace(/^import .+ from "\.\/layout\.mjs";\r?\n/m, ""), {
    filename: "ui/app.js",
});

function createRenderer() {
    const elements = new Map();
    const context = createContext({
        ...layout,
        document: {
            addEventListener() {},
            getElementById(id) {
                if (!elements.has(id)) {
                    elements.set(id, {
                        innerHTML: "",
                        style: {},
                        addEventListener() {},
                        querySelector() { return null; },
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
