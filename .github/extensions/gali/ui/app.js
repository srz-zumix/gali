// Canvas renderer. Talks to the loopback server over fetch + SSE and draws a
// day/3-day/week grid of the calendars gali can see.

import { HOUR_HEIGHT, MIN_GRID_HEIGHT, computeGeometry, clampGridHeight } from "./layout.mjs";
import { buildSharedEventGroups, calendarEventKey } from "./meetings.mjs";

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];
const CALENDAR_WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];
const MIN_ANCHOR_DATE = "0101-01-01";
const MAX_ANCHOR_DATE = "9998-12-31";
const SHARED_COLORS = [
    "#0969da", "#bc4c00", "#1a7f37", "#8250df", "#bf3989",
    "#087e8b", "#9a6700", "#cf222e", "#6f42c1", "#218b93",
];
const SHARING_BUSY_COLOR = "#6e7781";
const RESPONSE_LABELS = {
    accepted: "参加",
    declined: "辞退",
    tentative: "未定",
    needsAction: "未回答",
};

const $ = (id) => document.getElementById(id);
const state = {
    data: null, index: new Map(), whatIf: new Map(), scanId: null,
    sharedEvents: new Map(), hoveredEvent: null, focusedEvent: null,
    presetBusy: false, calendarDrag: null, orderQueue: Promise.resolve(), orderFailures: 0,
    dateAnchor: null, datePending: null, dateCalendar: null,
    shareLatched: false, sharePending: false, shareFailure: null,
};

/* ---------------- helpers ---------------- */

const escapeHtml = (value) =>
    String(value ?? "").replace(
        /[&<>"']/g,
        (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char],
    );

function sharingMode(settings = state.data?.settings) {
    return state.shareLatched || Boolean(settings?.shareMode);
}

function errorDetail(error, settings) {
    return sharingMode(settings) ? "共有モード中のため詳細は非表示です。" : String(error?.message || error);
}

function hexToRgba(hex, alpha) {
    const value = String(hex || "").replace("#", "");
    const full = value.length === 3 ? value.replace(/./g, (c) => c + c) : value;
    const int = Number.parseInt(full || "3f7ee8", 16);
    return `rgba(${(int >> 16) & 255}, ${(int >> 8) & 255}, ${int & 255}, ${alpha})`;
}

const pad2 = (value) => String(value).padStart(2, "0");
const localDate = (date) => `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
const hhmm = (minutes) => `${pad2(Math.floor(minutes / 60) % 24)}:${pad2(Math.round(minutes) % 60)}`;
const dayStartOf = (iso) => new Date(`${iso}T00:00:00`);

function formatDayLabel(iso) {
    const date = dayStartOf(iso);
    return `${date.getMonth() + 1}/${date.getDate()} (${WEEKDAYS[date.getDay()]})`;
}

function formatRange(range) {
    if (!range || !range.days.length) return "";
    const first = range.days[0];
    const last = range.days[range.days.length - 1];
    const start = dayStartOf(first);
    if (first === last) return `${start.getFullYear()}年 ${formatDayLabel(first)}`;
    const end = dayStartOf(last);
    const endYear = end.getFullYear() === start.getFullYear() ? "" : `${end.getFullYear()}年 `;
    return `${start.getFullYear()}年 ${formatDayLabel(first)} – ${endYear}${formatDayLabel(last)}`;
}

/* ---------------- server calls ---------------- */

// Per-instance capability handed to the iframe in its URL: the loopback server
// refuses any request without it, so another page on this machine cannot read
// the calendar data or change the settings.
const TOKEN = new URLSearchParams(location.search).get("token") || "";
const withToken = (path) => `${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(TOKEN)}`;

async function post(path, body) {
    const response = await fetch(withToken(path), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body || {}),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    apply(payload);
    return payload;
}

const patchSettings = (patch, refresh = true) => post("/api/settings", { settings: patch, refresh });

function selectedAnchor(data) {
    return data?.range?.anchor || data?.settings?.anchor || data?.range?.days?.[0] || localDate(new Date());
}

function validAnchorDate(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match || value < MIN_ANCHOR_DATE || value > MAX_ANCHOR_DATE) return false;
    const [, yearText, monthText, dayText] = match;
    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function datePickerError(message) {
    const element = $("date-picker-error");
    element.hidden = !message;
    element.textContent = message;
}

function displayedStart(data) {
    const start = data?.range?.days?.[0];
    return validAnchorDate(start) ? start : selectedAnchor(data);
}

function renderDatePicker(data) {
    $("date-picker-toggle").disabled = false;
    const anchor = selectedAnchor(data);
    if (state.datePending?.value === anchor) state.datePending = null;
    if (!state.datePending && state.dateAnchor !== anchor) {
        state.dateAnchor = anchor;
        datePickerError("");
    }
}

async function commitDateSelection(selected) {
    if (!validAnchorDate(selected)) {
        datePickerError("有効な日付を選択してください（0101-01-01〜9998-12-31）。");
        return;
    }
    datePickerError("");
    if (state.datePending?.value === selected) return;
    if (!state.datePending && selected === displayedStart(state.data)) return;
    const request = { value: selected };
    state.datePending = request;
    try {
        const payload = await patchSettings({ anchor: selected });
        if (state.datePending !== request) return;
        state.datePending = null;
        renderDatePicker(state.data);
        if (payload.error && selectedAnchor(payload) !== selected) {
            datePickerError(`日付を変更できませんでした: ${errorDetail(payload.error)}`);
        }
    } catch (error) {
        if (state.datePending !== request) return;
        state.datePending = null;
        renderDatePicker(state.data);
        datePickerError(`日付を変更できませんでした: ${errorDetail(error)}`);
    }
}

function dateCalendarISO(date) {
    return `${String(date.getUTCFullYear()).padStart(4, "0")}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

function shiftCalendarMonth(iso, amount) {
    const [year, month, day] = iso.split("-").map(Number);
    const first = new Date(Date.UTC(year, month - 1 + amount, 1));
    const nextYear = first.getUTCFullYear();
    const nextMonth = first.getUTCMonth();
    if (nextYear < 101 || nextYear > 9998) return null;
    const lastDay = new Date(Date.UTC(nextYear, nextMonth + 1, 0)).getUTCDate();
    first.setUTCDate(Math.min(day, lastDay));
    return dateCalendarISO(first);
}

function renderDateCalendar({ focusDay = true } = {}) {
    const calendar = state.dateCalendar;
    if (!calendar) return;
    const [year, month] = calendar.focus.split("-").map(Number);
    const first = new Date(Date.UTC(year, month - 1, 1));
    const leading = first.getUTCDay();
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const today = localDate(new Date());
    const rows = [];
    for (let offset = 0; offset < Math.ceil((leading + lastDay) / 7) * 7; offset += 7) {
        const cells = [];
        for (let column = 0; column < 7; column += 1) {
            const day = offset + column - leading + 1;
            if (day < 1 || day > lastDay) {
                cells.push('<td role="presentation"></td>');
                continue;
            }
            const iso = `${String(year).padStart(4, "0")}-${pad2(month)}-${pad2(day)}`;
            const selected = iso === calendar.selected;
            const focused = iso === calendar.focus;
            const current = iso === today ? ' aria-current="date"' : "";
            const inRange = calendar.range.has(iso) ? ' class="in-range"' : "";
            cells.push(`<td role="gridcell" aria-selected="${selected}"${inRange}><button type="button" data-picker-date="${iso}" tabindex="${focused ? 0 : -1}" aria-label="${year}年${month}月${day}日 ${CALENDAR_WEEKDAYS[column]}曜日"${current}>${day}</button></td>`);
        }
        rows.push(`<tr>${cells.join("")}</tr>`);
    }
    $("date-calendar-month").textContent = `${year}年${month}月`;
    $("date-calendar-prev").disabled = !shiftCalendarMonth(calendar.focus, -1);
    $("date-calendar-next").disabled = !shiftCalendarMonth(calendar.focus, 1);
    const days = $("date-calendar-days");
    days.innerHTML = rows.join("");
    if (focusDay) days.querySelector(`[data-picker-date="${calendar.focus}"]`)?.focus();
}

function moveDateCalendarMonths(amount, focusDay = true) {
    if (!state.dateCalendar) return;
    const next = shiftCalendarMonth(state.dateCalendar.focus, amount);
    if (!next) return;
    state.dateCalendar.focus = next;
    renderDateCalendar({ focusDay });
    if (!focusDay) {
        const button = $(amount < 0 ? "date-calendar-prev" : "date-calendar-next");
        (button.disabled ? $("date-calendar-month") : button).focus();
    }
}

function moveDateCalendarDays(amount) {
    if (!state.dateCalendar) return;
    const date = new Date(`${state.dateCalendar.focus}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + amount);
    const next = dateCalendarISO(date);
    if (!validAnchorDate(next)) return;
    state.dateCalendar.focus = next;
    renderDateCalendar();
}

function openDateCalendar() {
    if (state.dateCalendar) return;
    const start = displayedStart(state.data);
    const selected = validAnchorDate(start) ? start : localDate(new Date());
    const range = new Set((state.data?.range?.days || []).filter(validAnchorDate));
    state.dateCalendar = { selected, focus: selected, range };
    try {
        $("date-calendar").showModal();
    } catch (error) {
        state.dateCalendar = null;
        datePickerError(`カレンダーを開けませんでした: ${errorDetail(error)}`);
        return;
    }
    $("date-picker-toggle").setAttribute("aria-expanded", "true");
    renderDateCalendar();
}

function chooseCalendarDate(date) {
    if (!validAnchorDate(date)) {
        datePickerError("有効な日付を選択してください（0101-01-01〜9998-12-31）。");
        return;
    }
    const request = commitDateSelection(date);
    $("date-calendar").close();
    return request;
}

function calendarOrderMessage(message, isError = false) {
    const element = $("calendar-order-message");
    element.hidden = !message;
    element.className = isError ? "status error" : "hint";
    element.textContent = message;
}

function enqueueCalendarOperation(task) {
    const operation = state.orderQueue.then(task);
    state.orderQueue = operation.then(() => {}, () => {});
    return operation;
}

function moveCalendar(input) {
    return enqueueCalendarOperation(async () => {
        calendarOrderMessage("");
        try {
            await post("/api/calendars/move", input);
            const calendars = state.data.settings.calendars;
            const index = calendars.findIndex((entry) => entry.id === input.id);
            if (index >= 0) {
                const entry = calendars[index];
                const displayed = state.data.snapshot?.calendars.find((calendar) => calendar.id === entry.id);
                calendarOrderMessage(`${displayed?.label || entry.label || entry.id} を ${index + 1} 番目に移動しました。`);
            }
        } catch (error) {
            state.orderFailures += 1;
            calendarOrderMessage(`並び替えに失敗しました: ${errorDetail(error)}`, true);
        }
    });
}

function presetMessage(message, isError = false) {
    const element = $("preset-message");
    element.hidden = !message;
    element.className = isError ? "status error" : "hint";
    element.textContent = message;
}

async function postPreset(path, body) {
    if (state.presetBusy) return null;
    state.presetBusy = true;
    presetMessage("");
    if (state.data) renderPresets(state.data);
    try {
        const orderSensitive = ["/api/presets/create", "/api/presets/update", "/api/presets/apply"].includes(path);
        const save = path === "/api/presets/create" || path === "/api/presets/update";
        const failures = state.orderFailures;
        const operation = () => {
            if (save && state.orderFailures !== failures) {
                throw new Error("直前の並び替えに失敗したため、保存を中止しました。");
            }
            return post(path, body);
        };
        return await (orderSensitive ? enqueueCalendarOperation(operation) : operation());
    } catch (error) {
        presetMessage(`プリセットを操作できませんでした: ${errorDetail(error)}`, true);
        return null;
    } finally {
        state.presetBusy = false;
        if (state.data) renderPresets(state.data);
    }
}

/* ---------------- event placement ---------------- */

/** Clip one event to a single day column, returning wall-clock minutes. */
function clipToDay(event, iso) {
    const [year, month, day] = iso.split("-").map(Number);
    const dayStart = new Date(year, month - 1, day);
    const dayEnd = new Date(year, month - 1, day + 1);
    const start = new Date(event.start);
    const end = event.end ? new Date(event.end) : new Date(start.getTime() + 30 * 60_000);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
    if (end <= dayStart || start >= dayEnd) return null;
    // Wall-clock, not elapsed time: a DST day is 23 or 25 hours long and the
    // grid is drawn in clock coordinates. Must stay in sync with freebusy.mjs.
    const minutes = (date) =>
        date <= dayStart ? 0 : date >= dayEnd ? 1440 : date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60;
    const from = minutes(start);
    const to = minutes(end);
    if (to <= from) return null;
    return {
        event,
        startMin: from,
        endMin: to,
        continuesBefore: start.getTime() < dayStart.getTime(),
        continuesAfter: end.getTime() > dayEnd.getTime(),
    };
}

function coversDay(event, iso) {
    const start = event.start;
    const end = event.end || null;
    if (!end) return iso === start;
    return iso >= start && iso < end;
}

/** Side-by-side lanes for overlapping events inside one column. */
function assignLanes(items) {
    const sorted = [...items].sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin);
    const laneEnds = [];
    let cluster = [];
    let clusterEnd = -1;

    const flush = () => {
        for (const item of cluster) item.laneCount = laneEnds.length || 1;
        cluster = [];
        laneEnds.length = 0;
        clusterEnd = -1;
    };

    for (const item of sorted) {
        if (cluster.length && item.startMin >= clusterEnd) flush();
        let lane = laneEnds.findIndex((end) => end <= item.startMin);
        if (lane === -1) {
            lane = laneEnds.length;
            laneEnds.push(0);
        }
        laneEnds[lane] = item.endMin;
        item.lane = lane;
        item.laneCount = 1;
        cluster.push(item);
        clusterEnd = Math.max(clusterEnd, item.endMin);
    }
    if (cluster.length) flush();
    return sorted;
}

function visibleEvents(calendar, settings) {
    return calendar.events.filter((event) => settings.showDeclined || event.responseStatus !== "declined");
}

function timedEventHeight(placed) {
    return Math.max(14, ((placed.endMin - placed.startMin) / 60) * HOUR_HEIGHT - 2);
}

function effectiveEventEnd(event) {
    if (event.allDay) {
        const value = event.end || event.start;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
        const date = new Date(`${value}T00:00:00Z`);
        if (Number.isNaN(date.getTime()) || dateCalendarISO(date) !== value) return null;
        if (!event.end) date.setUTCDate(date.getUTCDate() + 1);
        return dateCalendarISO(date);
    }
    const end = event.end ? new Date(event.end).getTime() : new Date(event.start).getTime() + 30 * 60_000;
    return Number.isNaN(end) ? null : end;
}

function connectableTimed(items) {
    const overlapping = new Set();
    let active = [];
    for (const item of items) {
        const top = (item.startMin / 60) * HOUR_HEIGHT;
        const bottom = top + timedEventHeight(item);
        // Minimum-height blocks can overlap lanes from a cluster with different widths.
        // Ignore floating-point noise where block edges just touch.
        active = active.filter((other) => other.bottom > top + 1e-7);
        const left = item.lane / item.laneCount;
        const right = (item.lane + 1) / item.laneCount;
        for (const other of active) {
            if (left < other.right && other.left < right) {
                overlapping.add(item);
                overlapping.add(other.item);
            }
        }
        active.push({ item, bottom, left, right });
    }
    const edges = { left: new Set(), right: new Set() };
    for (const item of items) {
        if (overlapping.has(item)) continue;
        if (item.lane === 0) edges.left.add(item);
        if (item.lane === item.laneCount - 1) edges.right.add(item);
    }
    return edges;
}

function connectAdjacentEvents(columns) {
    const sharedGroup = (column, event) => state.sharedEvents.get(calendarEventKey(column.calendar.id, event.id));
    const timedEdges = columns.map((column) => connectableTimed(column.placed));
    const sameEnd = (left, right) => {
        const end = effectiveEventEnd(left);
        return end !== null && end === effectiveEventEnd(right);
    };

    for (let index = 0; index + 1 < columns.length; index += 1) {
        const left = columns[index];
        const right = columns[index + 1];
        if (left.day !== right.day) continue;

        const rightGroups = new Map();
        right.placed.forEach((item) => {
            const group = sharedGroup(right, item.event);
            if (group && timedEdges[index + 1].left.has(item)) rightGroups.set(group, item);
        });
        left.placed.forEach((item) => {
            if (!timedEdges[index].right.has(item)) return;
            const group = sharedGroup(left, item.event);
            const peer = group && rightGroups.get(group);
            if (!peer || item.startMin !== peer.startMin || item.endMin !== peer.endMin
                || !sameEnd(item.event, peer.event)) return;
            item.joinRight = true;
            peer.joinLeft = true;
        });

        for (let row = 0; row < Math.min(left.allDay.length, right.allDay.length); row += 1) {
            const item = left.allDay[row];
            const peer = right.allDay[row];
            const group = sharedGroup(left, item.event);
            if (group && group === sharedGroup(right, peer.event) && sameEnd(item.event, peer.event)) {
                item.joinRight = true;
                peer.joinLeft = true;
            }
        }
    }
}

/* ---------------- rendering ---------------- */

function completionLabel(event) {
    return event.completedFrom
        ? `補完元: ${event.completedFromName || event.completedFrom}`
        : "補完の可能性（推定・補完元不明）";
}

function renderCompletionBadge(event, settings) {
    if (!event.completed || !settings.showCompletionDiff) return "";
    const label = escapeHtml(completionLabel(event));
    return `<span class="badge" title="${label}" aria-label="${label}">${event.completedFrom ? "補" : "補?"}</span>`;
}

function sharedPeers(group, calendar) {
    return group.calendars.filter((member) => member.id !== calendar.id).map((member) => member.label).join("、");
}

function sharedLabel(group, calendar) {
    return group ? `同${group.number}（予定 ID / iCalUID・開始時刻が一致）: ${sharedPeers(group, calendar)}` : "";
}

function renderSharedBadge(group, calendar, sharing = false) {
    if (!group) return "";
    const label = escapeHtml(sharing ? `同${group.number}（共通予定）` : sharedLabel(group, calendar));
    return `<span class="shared-badge" title="${label}" aria-label="${label}">同${group.number}</span>`;
}

function eventColor(calendar, group, sharing) {
    if (!sharing) return calendar.color;
    return group ? SHARED_COLORS[(group.number - 1) % SHARED_COLORS.length] : SHARING_BUSY_COLOR;
}

function sharingEventTooltip(time, group, event) {
    return `${time} 予定あり${group ? ` 同${group.number}` : ""}${event.responseStatus === "declined" ? "（辞退）" : ""}`;
}

function renderEventBlock(placed, calendar, geometry, settings) {
    const { event, startMin, endMin, lane, laneCount } = placed;
    const top = ((startMin - geometry.startMinute) / 60) * HOUR_HEIGHT;
    const height = timedEventHeight(placed);
    const classes = ["ev"];
    const sharing = sharingMode(settings);
    if (sharing) classes.push("sharing");
    else {
        if (!event.detailsVisible) classes.push("masked");
        if (event.transparency === "transparent") classes.push("transparent");
    }
    if (event.responseStatus === "declined") classes.push("declined");

    const title = sharing ? "予定あり" : event.detailsVisible ? event.summary : "予定あり（詳細非公開）";
    const badge = sharing ? "" : renderCompletionBadge(event, settings);
    const shared = state.sharedEvents.get(calendarEventKey(calendar.id, event.id));
    const color = eventColor(calendar, shared, sharing);
    if (shared && height < 18) classes.push("compact");
    if (placed.joinLeft) classes.push("join-left");
    if (placed.joinRight) classes.push("join-right");
    const left = `${(lane / laneCount) * 100}%`;
    const width = `${100 / laneCount}%`;
    const extraWidth = Number(Boolean(placed.joinLeft)) + Number(Boolean(placed.joinRight));
    const positionedLeft = placed.joinLeft ? `calc(${left} - 1px)` : left;
    const positionedWidth = extraWidth ? `calc(${width} + ${extraWidth}px)` : width;
    const timeText = `${placed.continuesBefore ? "…" : ""}${hhmm(startMin)}${placed.continuesAfter ? "…" : ""}`;
    const timeRange = `${hhmm(startMin)}–${hhmm(endMin)}`;
    const tooltip = sharing
        ? sharingEventTooltip(timeRange, shared, event)
        : `${hhmm(startMin)}-${hhmm(endMin)} ${title}${event.completed ? `\n${completionLabel(event)}` : ""}${shared ? `\n${sharedLabel(shared, calendar)}` : ""}`;
    const identity = sharing
        ? `data-share-time="${escapeHtml(timeRange)}" aria-label="${escapeHtml(tooltip)}"`
        : `data-cal="${escapeHtml(calendar.id)}" data-ev="${escapeHtml(event.id)}"`;

    return `<button type="button" class="${classes.join(" ")}"
        style="top:${top}px;height:${height}px;left:${positionedLeft};width:${positionedWidth};--ev-color:${color};--ev-fill:${hexToRgba(color, 0.22)}"
        ${identity}
        ${shared ? `data-shared="${shared.number}"` : ""}
        title="${escapeHtml(tooltip)}"
        >${renderSharedBadge(shared, calendar, sharing)}<span class="t">${escapeHtml(timeText)}</span> ${escapeHtml(title)}${badge}</button>`;
}

function renderAllDay(event, calendar, settings, placement = {}) {
    const classes = ["ev"];
    const sharing = sharingMode(settings);
    if (sharing) classes.push("sharing");
    else {
        if (!event.detailsVisible) classes.push("masked");
    }
    if (event.responseStatus === "declined") classes.push("declined");
    if (placement.joinLeft) classes.push("join-left");
    if (placement.joinRight) classes.push("join-right");
    const title = sharing ? "予定あり" : event.detailsVisible ? event.summary : "予定あり（詳細非公開）";
    const badge = sharing ? "" : renderCompletionBadge(event, settings);
    const shared = state.sharedEvents.get(calendarEventKey(calendar.id, event.id));
    const color = eventColor(calendar, shared, sharing);
    const tooltip = sharing
        ? sharingEventTooltip("終日", shared, event)
        : `${title}${event.completed ? `\n${completionLabel(event)}` : ""}${shared ? `\n${sharedLabel(shared, calendar)}` : ""}`;
    const identity = sharing
        ? `data-share-time="終日" aria-label="${escapeHtml(tooltip)}"`
        : `data-cal="${escapeHtml(calendar.id)}" data-ev="${escapeHtml(event.id)}"`;
    return `<button type="button" class="${classes.join(" ")}"
        style="--ev-color:${color};--ev-fill:${hexToRgba(color, 0.22)}"
        ${identity}
        ${shared ? `data-shared="${shared.number}"` : ""}
        title="${escapeHtml(tooltip)}"
        >${renderSharedBadge(shared, calendar, sharing)}${escapeHtml(title)}${badge}</button>`;
}

function renderGrid(data) {
    const grid = $("grid");
    const snapshot = data.snapshot;
    const settings = data.settings;
    const calendars = (snapshot?.calendars || []).map((calendar) => ({
        ...calendar,
        events: visibleEvents(calendar, settings),
    }));
    state.sharedEvents = buildSharedEventGroups(calendars);
    state.hoveredEvent = null;
    state.focusedEvent = null;

    if (!settings.calendars.length) {
        grid.innerHTML =
            '<p class="placeholder">「設定」から見たい人のカレンダー ID（メールアドレス）を追加してください。<br />gali が閲覧できる範囲の予定だけが表示されます。</p>';
        return;
    }
    if (!snapshot) {
        grid.innerHTML = '<p class="placeholder">gali で予定を取得しています…</p>';
        return;
    }

    const days = snapshot.range.days;
    const today = localDate(new Date());

    const columns = [];
    for (const day of days) {
        for (const calendar of calendars) {
            const events = calendar.events;
            const timed = [];
            for (const event of events) {
                if (event.allDay) continue;
                const placed = clipToDay(event, day);
                if (placed) timed.push(placed);
            }
            columns.push({
                day,
                calendar,
                placed: assignLanes(timed),
                allDay: events.filter((event) => event.allDay && coversDay(event, day)).map((event) => ({ event })),
            });
        }
    }
    const sharing = sharingMode(settings);
    if (sharing) connectAdjacentEvents(columns);

    const geometry = computeGeometry(settings);
    const showOwners = calendars.length > 1;

    const dayHeaders = days
        .map(
            (day) =>
                `<th class="day${day === today ? " today" : ""}" colspan="${calendars.length}">${escapeHtml(formatDayLabel(day))}</th>`,
        )
        .join("");

    const ownerHeaders = showOwners
        ? `<tr>${days
              .map(() =>
                  calendars
                      .map(
                          (calendar) =>
                              `<th class="owner" scope="col" draggable="true" data-order-calendar="${escapeHtml(calendar.id)}"
                                  title="${escapeHtml(`${calendar.id}\nドラッグして列を並べ替え`)}"><span class="owner-name"><span class="drag-handle" aria-hidden="true">⋮⋮</span><span class="dot" style="background:${calendar.color}"></span>${escapeHtml(calendar.label)}</span></th>`,
                      )
                      .join(""),
              )
              .join("")}</tr>`
        : "";

    const splitAllDay = sharing && columns.some((column) =>
        column.allDay.length > 1 && column.allDay.some((item) => item.joinLeft || item.joinRight));
    const maxAllDay = columns.reduce((count, column) => Math.max(count, column.allDay.length), 0);
    const allDaySegments = [];
    if (splitAllDay) {
        const joinedRows = new Set();
        for (const column of columns) {
            column.allDay.forEach((item, index) => {
                if (item.joinLeft || item.joinRight) joinedRows.add(index);
            });
        }
        let start = 0;
        for (const row of [...joinedRows].sort((a, b) => a - b)) {
            if (start < row) allDaySegments.push([start, row]);
            allDaySegments.push([row, row + 1]);
            start = row + 1;
        }
        if (start < maxAllDay) allDaySegments.push([start, maxAllDay]);
    } else {
        allDaySegments.push([0, maxAllDay]);
    }
    const allDayRows = allDaySegments.map(([start, end], row) => {
        const cells = columns
            .map((column, index) => {
                const placements = column.allDay.slice(start, end);
                return `<td class="${index % calendars.length === 0 ? "daystart" : ""}"><div class="allday">${placements
                    .map((placement) => renderAllDay(placement.event, column.calendar, settings, placement))
                    .join("")}</div></td>`;
            })
            .join("");
        const last = row === allDaySegments.length - 1 ? " allday-last" : "";
        return `<tr class="allday-row${last}"><td class="gutter"><div class="allday"></div></td>${cells}</tr>`;
    }).join("");

    const hourLabels = [];
    for (let hour = geometry.startHour; hour <= geometry.endHour; hour += 1) {
        hourLabels.push(
            `<span class="label" style="top:${(hour - geometry.startHour) * HOUR_HEIGHT}px">${pad2(hour)}:00</span>`,
        );
    }

    const nowMinutes = new Date().getHours() * 60 + new Date().getMinutes();
    const bodyCells = columns
        .map((column, index) => {
            const lines = [];
            for (let hour = geometry.startHour + 1; hour < geometry.endHour; hour += 1) {
                lines.push(`<div class="hline" style="top:${(hour - geometry.startHour) * HOUR_HEIGHT}px"></div>`);
            }
            const workTop = ((geometry.workStart - geometry.startMinute) / 60) * HOUR_HEIGHT;
            const workHeight = ((geometry.workEnd - geometry.workStart) / 60) * HOUR_HEIGHT;
            const work =
                workHeight > 0
                    ? `<div class="work" style="top:${Math.max(0, workTop)}px;height:${workHeight}px"></div>`
                    : "";
            const now =
                column.day === today && nowMinutes >= geometry.startMinute
                    ? `<div class="now" style="top:${((nowMinutes - geometry.startMinute) / 60) * HOUR_HEIGHT}px"></div>`
                    : "";
            const blocks = column.placed
                .map((placed) => renderEventBlock(placed, column.calendar, geometry, settings))
                .join("");
            return `<td class="${index % calendars.length === 0 ? "daystart" : ""}"><div class="col" style="height:${geometry.height}px">${work}${lines.join("")}${now}${blocks}</div></td>`;
        })
        .join("");

    // The panel is often narrow, so keep columns readable and let the grid scroll
    // horizontally instead of squeezing 21 columns into 400px.
    const minColumnWidth = columns.length <= 3 ? 120 : calendars.length > 1 ? 78 : 92;
    const minWidth = 56 + columns.length * minColumnWidth;

    grid.innerHTML = `<table class="cal" style="min-width:${minWidth}px">
        <thead>
            <tr><th class="gutter" ${showOwners ? 'rowspan="2"' : ""}></th>${dayHeaders}</tr>
            ${ownerHeaders}
        </thead>
        <tbody>
            ${allDayRows}
            <tr><td class="gutter"><div class="hours" style="height:${geometry.height}px">${hourLabels.join("")}</div></td>${bodyCells}</tr>
        </tbody>
    </table>`;

    // The second header row has to stick below the first one, whose height
    // depends on the rendered font, so measure it instead of guessing.
    const dayHeader = grid.querySelector("th.day");
    if (dayHeader) {
        document.documentElement.style.setProperty("--gali-day-head", `${Math.round(dayHeader.getBoundingClientRect().height)}px`);
    }
}

/* ---------------- free slots ---------------- */

function renderFreeSlots(data) {
    const container = $("free-slots");
    const snapshot = data.snapshot;
    const freeSlots = data.freeSlots || [];
    if (!snapshot || !data.settings.showFreeSlots || !freeSlots.length) {
        container.innerHTML = "";
        return;
    }
    const usable = snapshot.calendars.filter((calendar) => !calendar.error).length;
    const rows = freeSlots
        .map(({ day, slots }) => {
            const body = slots.length
                ? slots.map(([start, end]) => `<span class="slot">${hhmm(start)}–${hhmm(end)}</span>`).join("")
                : '<span class="none">空きなし</span>';
            return `<div class="free-day"><span class="d">${escapeHtml(formatDayLabel(day))}</span>${body}</div>`;
        })
        .join("");
    container.innerHTML = `<h2>全員が空いている時間（${escapeHtml(data.settings.workStart)}–${escapeHtml(data.settings.workEnd)}, ${usable} 人）</h2>${rows}
        <p class="hint">時間指定のある予定のみを対象にしています。「空き時間」扱いの予定と終日予定は考慮していません。</p>`;
}

/* ---------------- chrome ---------------- */

function renderChips(data) {
    const chips = $("chips");
    const snapshot = data.snapshot;
    const sharing = sharingMode(data.settings);
    const active = document.activeElement;
    const focused = active?.dataset?.moveCalendar
        ? { id: active.dataset.moveCalendar, direction: active.dataset.direction }
        : null;
    if (!data.settings.calendars.length) {
        chips.innerHTML = '<span class="empty">カレンダー未設定</span>';
        return;
    }
    chips.innerHTML = data.settings.calendars
        .map((entry, index, entries) => {
            const found = snapshot && snapshot.calendars.find((calendar) => calendar.id === entry.id);
            const color = found ? found.color : "var(--gali-muted)";
            const label = (found && found.label) || entry.label || entry.id;
            let meta = "";
            if (found && found.error) meta = '<span class="meta error">取得エラー</span>';
            else if (found && !sharing) {
                const hidden = found.stats.hidden ? ` / 非公開 ${found.stats.hidden}` : "";
                const declined = found.stats.declined
                    ? ` / 辞退 ${found.stats.declined}${data.settings.showDeclined ? "" : "（非表示）"}`
                    : "";
                meta = `<span class="meta">${found.stats.total} 件${hidden}${declined}</span>`;
            }
            const controls = entries.length > 1
                ? `<span class="chip-order">
                    <button type="button" data-move-calendar="${escapeHtml(entry.id)}" data-direction="left"
                        aria-label="${escapeHtml(`${label}を左へ移動`)}" title="左へ移動" ${index === 0 ? "disabled" : ""}>←</button>
                    <button type="button" data-move-calendar="${escapeHtml(entry.id)}" data-direction="right"
                        aria-label="${escapeHtml(`${label}を右へ移動`)}" title="右へ移動" ${index === entries.length - 1 ? "disabled" : ""}>→</button>
                </span>`
                : "";
            return `<span class="chip" title="${escapeHtml(`${entry.id}${found && found.error ? `\n${errorDetail(found.error, data.settings)}` : ""}`)}">
                <i class="dot" style="background:${color}"></i>
                <span class="name">${escapeHtml(label)}</span>${meta}${controls}
                <button type="button" data-remove="${escapeHtml(entry.id)}" title="削除">×</button>
            </span>`;
        })
        .join("");
    if (focused) {
        const buttons = [...chips.querySelectorAll("button[data-move-calendar]")];
        const same = buttons.find((button) => button.dataset.moveCalendar === focused.id
            && button.dataset.direction === focused.direction && !button.disabled);
        const other = buttons.find((button) => button.dataset.moveCalendar === focused.id && !button.disabled);
        (same || other)?.focus({ preventScroll: true });
    }
}

function renderPresets(data) {
    const presets = Array.isArray(data.presets) ? data.presets : [];
    const select = $("preset-select");
    const previous = select.value || "";
    const options = `<option value="">プリセットを選択</option>${presets
        .map((preset) => `<option value="${escapeHtml(preset.id)}">${escapeHtml(preset.name)}（${preset.calendars.length}人）</option>`)
        .join("")}`;
    const signature = JSON.stringify(presets.map((preset) => [preset.id, preset.name, preset.calendars.length]));
    if (select.dataset.optionsSignature !== signature) {
        select.innerHTML = options;
        select.dataset.optionsSignature = signature;
        select.value = presets.some((preset) => preset.id === previous) ? previous : "";
    }
    const selected = presets.find((preset) => preset.id === select.value);
    if (!selected) $("preset-delete-confirm").hidden = true;
    select.disabled = state.presetBusy || !presets.length;
    $("apply-preset").disabled = state.presetBusy || !selected;
    $("update-preset").disabled = state.presetBusy || !selected || !data.settings.calendars.length;
    $("delete-preset").disabled = state.presetBusy || !selected;
    $("confirm-delete-preset").disabled = state.presetBusy || !selected;
    $("refresh-presets").disabled = state.presetBusy;
    $("save-preset").disabled = state.presetBusy || !data.settings.calendars.length || !$("preset-name").value.trim();
    $("preset-summary").textContent = selected
        ? `${selected.name}: ${selected.calendars.map((entry) => entry.label || entry.id).join("、")}`
        : "プリセットを選択するとメンバーを確認できます。";
    const error = $("preset-store-error");
    error.hidden = !data.presetError;
    error.textContent = data.presetError
        ? `${sharingMode(data.settings) ? "プリセットの読み込みに失敗しました: " : ""}${errorDetail(data.presetError, data.settings)}`
        : "";
}

function renderSharing(data) {
    const sharing = sharingMode(data.settings);
    const unsaved = sharing && !data.settings.shareMode && !state.sharePending;
    const warning = state.shareFailure?.message || (unsaved
        ? "保存された共有モードは解除されています。この画面では予定を隠していますが、再読込すると表示されます。"
        : "");
    const toggle = $("toggle-share");
    toggle.disabled = state.sharePending;
    toggle.setAttribute("aria-pressed", String(sharing));
    toggle.title = sharing ? "予定の内容を隠しています" : "予定の内容を隠して共有します";
    $("normal-legend").hidden = sharing;
    $("share-legend").hidden = !sharing;
    $("share-mode-error").hidden = !warning;
    $("share-mode-error-text").textContent = warning;
    $("retry-share-mode").hidden = !state.shareFailure;
    $("retry-share-mode").disabled = state.sharePending;
}

function renderSettings(data) {
    const settings = data.settings;
    const assign = (id, value, property = "value") => {
        const element = $(id);
        if (element && document.activeElement !== element) element[property] = value;
    };
    assign("ref-mycals", settings.refMyCals, "checked");
    assign("show-diff", settings.showCompletionDiff, "checked");
    assign("show-declined", settings.showDeclined, "checked");
    assign("show-free", settings.showFreeSlots, "checked");
    assign("refs", settings.refs.join(", "));
    assign("building", settings.building);
    assign("work-start", settings.workStart);
    assign("work-end", settings.workEnd);
    assign("skip-holidays", settings.skipHolidays, "checked");
    assign("skip-policy", settings.skipPolicySlots, "checked");
    assign("away-busy", settings.treatAwayAsBusy, "checked");
    assign("weekdays-only", settings.scanWeekdaysOnly, "checked");
    assign("holiday-cal", settings.holidayCalendarId);
    assign("policy-patterns", (settings.policyPatterns || []).join(", "));
    assign("scan-duration", String(settings.slotMinutes));
    assign("scan-weeks", String(settings.scanWeeks));
    $("policy-pattern-field").hidden = sharingMode(settings);
    $("profile-label").textContent = data.profile;

    for (const button of document.querySelectorAll("#view-group button")) {
        button.setAttribute("aria-pressed", String(button.dataset.view === settings.view));
    }
}

/* ---------------- adjust panel ---------------- */

const KIND_LABELS = { away: "終日ブロック", policy: "ポリシー枠", meeting: "会議" };

function renderScanProgress(data) {
    const element = $("scan-progress");
    const progress = data.scanProgress;
    if (!progress) {
        element.hidden = true;
        return;
    }
    element.hidden = false;
    const phase = progress.phase === "analyzing" ? "解析中" : "gali で取得中";
    const cached = progress.cached ? `（${progress.cached} 件はキャッシュ）` : "";
    element.textContent = `${phase} ${progress.done}/${progress.total}${cached}`;
}

function renderCandidates(scan, sharing = false) {
    const pane = $("tab-candidates");
    if (!scan) {
        pane.innerHTML = `<p class="hint">「候補を探す」で ${$("scan-weeks").value} 週間先まで全員の空きを探します。</p>`;
        return;
    }
    const hints = sharing ? "" : (scan.hint || []).map((text) => `<li>${escapeHtml(text)}</li>`).join("");
    if (!scan.candidates.length) {
        pane.innerHTML = `<p class="empty">${escapeHtml(scan.from)} 〜 ${escapeHtml(scan.until)} に ${scan.durationMinutes}分の空きはありません。</p>${hints ? `<ul class="notes">${hints}</ul>` : ""}`;
        return;
    }
    const rows = scan.candidates
        .slice(0, 30)
        .map((candidate, position) => {
            const reasons = sharing ? "" : candidate.reasons.map((text) => `<li>${escapeHtml(text)}</li>`).join("");
            return `<li class="candidate${position === 0 ? " top" : ""}">
                <div class="candidate-head">
                    <span class="candidate-when">${escapeHtml(formatDayLabel(candidate.day))} ${escapeHtml(candidate.start)}–${escapeHtml(candidate.end)}</span>
                    <span class="candidate-block">連続 ${candidate.blockMinutes}分</span>
                </div>
                ${reasons ? `<ul class="reasons">${reasons}</ul>` : ""}
            </li>`;
        })
        .join("");
    pane.innerHTML = `<p class="hint">${escapeHtml(scan.from)} 〜 ${escapeHtml(scan.until)} / ${scan.durationMinutes}分 / 全員空き ${scan.totalFreeSlots} 枠</p>
        ${hints ? `<ul class="notes">${hints}</ul>` : ""}
        <ol class="candidates">${rows}</ol>`;
}

function renderBlockers(scan, sharing = false) {
    const pane = $("tab-blockers");
    if (!scan) {
        pane.innerHTML = `<p class="hint">スキャン後に、誰がどれだけ枠を塞いでいるかを表示します。</p>`;
        return;
    }
    const rows = scan.blockers
        .map(
            (blocker) => `<tr>
                <td>${escapeHtml(blocker.label)}</td>
                <td class="num">${blocker.slotsBlocked}</td>
                <td class="num strong">${blocker.soleBlocker}</td>
                ${sharing ? "" : `<td class="num">${blocker.awaySlots}</td>`}
            </tr>`,
        )
        .join("");
    const near = scan.nearMiss
        .slice(0, 25)
        .map(
            (slot) => `<li${sharing ? "" : ` class="${slot.movable ? "movable" : "immovable"}"`}>
                <span class="near-when">${escapeHtml(formatDayLabel(slot.day))} ${escapeHtml(slot.start)}–${escapeHtml(slot.end)}</span>
                <span class="near-who">${escapeHtml(slot.blocker)}</span>
                <span class="near-what">${sharing ? "予定あり" : slot.events.map((event) => `${escapeHtml(event.title)}<i>${escapeHtml(KIND_LABELS[event.kind] || event.kind)}</i>`).join(" / ")}</span>
            </li>`,
        )
        .join("");
    pane.innerHTML = `<table class="blockers">
            <thead><tr><th>参加者</th><th class="num">塞いだ枠</th><th class="num">単独原因</th>${sharing ? "" : '<th class="num">終日ブロック</th>'}</tr></thead>
            <tbody>${rows}</tbody>
        </table>
        <h4>あと1人空けば成立する枠</h4>
        ${near ? `<ul class="near-miss">${near}</ul>` : '<p class="hint">該当なし</p>'}
        ${sharing ? "" : '<p class="hint">緑＝会議なのでリスケ交渉の余地あり / 赤＝終日ブロックなので会議を動かしても空きません。</p>'}`;
}

function whatIfMarkup(id) {
    const result = state.whatIf.get(id);
    if (!result) return "";
    if (result.pending) return `<p class="whatif-result">計算中…</p>`;
    if (result.error) return `<p class="whatif-result">計算できませんでした。先にスキャンを実行してください。</p>`;
    if (result.delta > 0) {
        const examples = (result.gainedSlots || [])
            .slice(0, 3)
            .map((slot) => `${formatDayLabel(slot.day)} ${slot.start}`)
            .join(" / ");
        return `<p class="whatif-result gain">動かすと ${result.delta} 枠増えます（${result.baselineCount} → ${result.afterCount}）${examples ? `。例: ${escapeHtml(examples)}` : ""}</p>`;
    }
    return `<p class="whatif-result nogain">動かしても空きは増えません（${result.baselineCount} 枠のまま）。別の要因が塞いでいます。</p>`;
}

function renderShared(scan, sharing = sharingMode()) {
    const pane = $("tab-shared");
    if (!scan) {
        pane.innerHTML = `<p class="hint">スキャン後に、複数人が同席している会議を表示します。</p>`;
        return;
    }
    if (!scan.sharedMeetings.length) {
        pane.innerHTML = `<p class="empty">2人以上が同席している予定はありません。</p>`;
        return;
    }
    const total = scan.calendars.length;
    const rows = scan.sharedMeetings
        .slice(0, 40)
        .map((meeting, position) => {
            const everyone = meeting.attendeeCount >= total;
            return `<li class="${everyone ? "everyone" : ""}">
                <div class="shared-head">
                    <span class="shared-count">${meeting.attendeeCount}人</span>
                    <span class="shared-title">${sharing ? "予定あり" : escapeHtml(meeting.title)}</span>
                    ${!sharing && meeting.recurring ? '<span class="tag">定期</span>' : ""}
                    ${everyone ? '<span class="tag ok">全員</span>' : ""}
                </div>
                <div class="shared-meta">${escapeHtml(meeting.attendees.join("・"))}${sharing ? "" : ` / ${meeting.occurrences}回`} / ${escapeHtml(String(meeting.firstStart).slice(0, 16).replace("T", " "))}</div>
                <button type="button" class="whatif" data-whatif="${position}">動かしたら何枠空く？</button>
                ${whatIfMarkup(meeting.keys.join("|"))}
            </li>`;
        })
        .join("");
    pane.innerHTML = `<ul class="shared">${rows}</ul>`;
}

function renderAdjust(data) {
    const sharing = sharingMode(data.settings);
    renderScanProgress(data);
    renderCandidates(data.scan, sharing);
    renderBlockers(data.scan, sharing);
    renderShared(data.scan, sharing);
    const busy = Boolean(data.scanProgress);
    $("scan-btn").disabled = busy;
    $("scan-force").disabled = busy;
}

function renderStatus(data) {
    const status = $("status");
    const errors = [];
    const sharing = sharingMode(data.settings);
    if (data.error) errors.push(`${sharing ? "処理に失敗しました: " : ""}${errorDetail(data.error, data.settings)}`);
    for (const calendar of (data.snapshot && data.snapshot.calendars) || []) {
        if (calendar.error) {
            errors.push(`${calendar.label}: ${sharing ? "取得に失敗しました: " : ""}${errorDetail(calendar.error, data.settings)}`);
        }
    }
    if (errors.length) {
        status.className = "status error";
        status.textContent = errors.join("\n");
        return;
    }
    if (data.loading) {
        status.className = "status loading";
        status.textContent = "gali で取得中…";
    } else if (data.snapshot) {
        status.className = "status";
        const at = new Date(data.snapshot.fetchedAt);
        const refs = data.snapshot.usingReferences ? " / 参照カレンダーで非公開予定を補完" : "";
        const cache = data.snapshot.cache;
        const cached = cache?.hits
            ? ` / キャッシュ${cache.hits < cache.chunks ? ` ${cache.hits}/${cache.chunks}` : ""}`
            : "";
        status.textContent = `最終取得 ${pad2(at.getHours())}:${pad2(at.getMinutes())}${cached}${refs}`;
    } else {
        status.className = "status";
        status.textContent = "";
    }
}

function apply(data) {
    if (!data || !data.settings) return;
    if (Number.isInteger(data.revision) && Number.isInteger(state.data?.revision) && data.revision < state.data.revision) return;
    if (data.settings.shareMode && !state.shareLatched) activateSharing();
    hidePopover();
    // what-if results describe one specific scan (its duration, window and
    // participants). Keeping them across a new or invalidated scan would show a
    // stale "+N 枠" for a meeting whose key happens to be unchanged.
    const scanId = data.scan ? data.scan.fetchedAt : null;
    if (scanId !== state.scanId) {
        state.scanId = scanId;
        state.whatIf = new Map();
    }
    state.data = data;
    state.index = new Map();
    for (const calendar of (data.snapshot && data.snapshot.calendars) || []) {
        for (const event of calendar.events) state.index.set(calendarEventKey(calendar.id, event.id), { calendar, event });
    }
    $("range-label").textContent = formatRange(data.range || (data.snapshot && data.snapshot.range));
    $("refresh").disabled = Boolean(data.loading);
    renderDatePicker(data);
    renderSharing(data);
    renderSettings(data);
    renderPresets(data);
    if (!state.calendarDrag) renderChips(data);
    renderStatus(data);
    if (!state.calendarDrag) renderGrid(data);
    renderFreeSlots(data);
    renderAdjust(data);
    renderGridHeight();
}

/* ---------------- calendar viewport ---------------- */

const gridResizer = $("grid-resizer");
let gridDrag = null;
let pendingGridSize = null;
let gridSizeSave = Promise.resolve();

function availableGridHeight() {
    return Math.max(MIN_GRID_HEIGHT, $("calendar-main").clientHeight - gridResizer.offsetHeight);
}

function resizeGrid(height) {
    const maximum = availableGridHeight();
    const actual = clampGridHeight(height, maximum);
    $("grid").style.height = `${actual}px`;
    gridResizer.setAttribute("aria-valuemax", String(maximum));
    gridResizer.setAttribute("aria-valuenow", String(actual));
    gridResizer.setAttribute("aria-valuetext", `${actual} px`);
    return actual;
}

function renderGridHeight() {
    if (gridDrag) return;
    const height = pendingGridSize?.height ?? state.data?.settings.gridHeight;
    resizeGrid(height || availableGridHeight());
}

function saveGridHeight(height) {
    const change = { height };
    pendingGridSize = change;
    gridSizeSave = gridSizeSave.then(async () => {
        try {
            const payload = await patchSettings({ gridHeight: height }, false);
            if (payload.error) throw new Error(payload.error);
        } catch (error) {
            const status = $("status");
            status.className = "status error";
            status.textContent = `表示領域の高さを保存できませんでした: ${errorDetail(error)}`;
        } finally {
            if (pendingGridSize === change) pendingGridSize = null;
            renderGridHeight();
        }
    });
    return gridSizeSave;
}

gridResizer.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || gridDrag) return;
    event.preventDefault();
    hidePopover();
    gridDrag = {
        pointerId: event.pointerId,
        startY: event.clientY,
        startHeight: $("grid").getBoundingClientRect().height,
    };
    gridResizer.setPointerCapture(event.pointerId);
    gridResizer.focus();
    document.body.classList.add("grid-resizing");
});

gridResizer.addEventListener("pointermove", (event) => {
    if (!gridDrag || gridDrag.pointerId !== event.pointerId) return;
    resizeGrid(gridDrag.startHeight + event.clientY - gridDrag.startY);
});

function finishGridResize(event) {
    if (!gridDrag || gridDrag.pointerId !== event.pointerId) return;
    const height = Math.round($("grid").getBoundingClientRect().height);
    gridDrag = null;
    document.body.classList.remove("grid-resizing");
    if (gridResizer.hasPointerCapture(event.pointerId)) gridResizer.releasePointerCapture(event.pointerId);
    if (event.type === "pointercancel") renderGridHeight();
    else saveGridHeight(height);
}

gridResizer.addEventListener("pointerup", finishGridResize);
gridResizer.addEventListener("pointercancel", finishGridResize);
gridResizer.addEventListener("lostpointercapture", finishGridResize);
gridResizer.addEventListener("keydown", (event) => {
    const current = $("grid").getBoundingClientRect().height;
    const heights = {
        ArrowUp: current - 32,
        ArrowDown: current + 32,
        Home: MIN_GRID_HEIGHT,
        End: availableGridHeight(),
    };
    if (heights[event.key] === undefined) return;
    event.preventDefault();
    saveGridHeight(resizeGrid(heights[event.key]));
});
gridResizer.addEventListener("dblclick", () => saveGridHeight(0));
new ResizeObserver(renderGridHeight).observe($("calendar-main"));

/* ---------------- popover ---------------- */

function showPopover(target) {
    let markup;
    if (sharingMode()) {
        const time = target.dataset.shareTime;
        if (!time) return;
        const number = /^\d+$/.test(target.dataset.shared || "") ? target.dataset.shared : "";
        const declined = target.classList.contains("declined");
        markup = `<h3>予定あり</h3><dl><dt>日時</dt><dd>${escapeHtml(time)}</dd>${number ? `<dt>共通予定</dt><dd>同${number}</dd>` : ""}${declined ? "<dt>参加状況</dt><dd>辞退</dd>" : ""}</dl>`;
    } else {
        const key = calendarEventKey(target.dataset.cal, target.dataset.ev);
        const entry = state.index.get(key);
        if (!entry) return;
        const { calendar, event } = entry;
        const rows = [];
        const push = (term, value) => {
            if (value) rows.push(`<dt>${escapeHtml(term)}</dt><dd>${escapeHtml(value)}</dd>`);
        };

        if (event.allDay) {
            push("日時", `${event.start} 〜 (終日)`);
        } else {
            const start = new Date(event.start);
            const end = new Date(event.end);
            push(
                "日時",
                `${localDate(start)} ${pad2(start.getHours())}:${pad2(start.getMinutes())} – ${pad2(end.getHours())}:${pad2(end.getMinutes())}`,
            );
        }
        push("カレンダー", calendar.label);
        const shared = state.sharedEvents.get(key);
        if (shared) {
            push("同じ予定", `同${shared.number}（予定 ID / iCalUID・開始時刻が一致）`);
            push("他のカレンダー", sharedPeers(shared, calendar));
        }
        push("場所", event.location);
        push("主催者", event.organizer);
        if (event.attendeeCount) push("参加者", `${event.attendeeCount} 名`);
        push("参加状況", RESPONSE_LABELS[event.responseStatus] || "");
        push("公開範囲", event.detailsVisible ? event.visibility || "既定" : "詳細非公開（空き時間のみ共有）");
        if (event.transparency === "transparent") push("予定の扱い", "空き時間");
        if (event.completedFrom) {
            push("補完元カレンダー", event.completedFromName || event.completedFrom);
            if (event.completedFromName && event.completedFromName !== event.completedFrom) {
                push("補完元 ID", event.completedFrom);
            }
        } else if (event.completed) push("補完", "推定・補完元不明（旧 CLI のため確認できません）");
        if (event.description) push("説明", event.description.slice(0, 400));
        markup = `<h3>${escapeHtml(event.detailsVisible ? event.summary : "予定あり（詳細非公開）")}</h3><dl>${rows.join("")}</dl>`;
    }

    const popover = $("popover");
    popover.innerHTML = markup;
    popover.hidden = false;

    const rect = target.getBoundingClientRect();
    const box = popover.getBoundingClientRect();
    const left = Math.min(Math.max(8, rect.left), window.innerWidth - box.width - 8);
    const top = rect.bottom + box.height + 8 > window.innerHeight ? Math.max(8, rect.top - box.height - 6) : rect.bottom + 6;
    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;
}

const hidePopover = () => {
    $("popover").hidden = true;
    $("popover").innerHTML = "";
};

/* ---------------- wiring ---------------- */

function activateSharing() {
    state.shareLatched = true;
    if (state.calendarDrag) cancelCalendarDrag();
    hidePopover();
    for (const [id, prefix] of [
        ["date-picker-error", "日付の操作に失敗しました。"],
        ["calendar-order-message", "カレンダーの操作に失敗しました。"],
        ["preset-message", "プリセットの操作に失敗しました。"],
        ["calendar-hint", "カレンダーの操作に失敗しました。"],
    ]) {
        const element = $(id);
        const hadError = Boolean(element.textContent) && (id === "date-picker-error"
            || element.className === "status error" || (id === "calendar-hint" && element.textContent.includes("失敗")));
        element.textContent = hadError ? `${prefix}共有モード中のため詳細は非表示です。` : "";
        if (id !== "calendar-hint") element.hidden = !hadError;
    }
}

async function saveShareMode(enabled) {
    if (!state.data || state.sharePending) return;
    state.sharePending = true;
    state.shareFailure = null;
    if (!state.shareLatched) activateSharing();
    apply(state.data);
    try {
        const payload = await patchSettings({ shareMode: enabled }, false);
        if (Boolean(payload.settings?.shareMode) !== enabled || Boolean(state.data?.settings?.shareMode) !== enabled) {
            throw new Error("共有モードの設定を保存できませんでした。");
        }
        if (!enabled) state.shareLatched = false;
    } catch (error) {
        state.shareFailure = {
            target: enabled,
            message: enabled
                ? "共有モードを保存できませんでした。この画面では予定を隠していますが、再読込後は解除される可能性があります。"
                : "共有モードを解除できませんでした。予定は引き続き隠しています。",
        };
    } finally {
        state.sharePending = false;
        apply(state.data);
    }
}

function highlightSharedEvents() {
    const number = (state.hoveredEvent || state.focusedEvent)?.dataset.shared;
    for (const block of $("grid").querySelectorAll(".ev[data-shared]")) {
        block.classList.toggle("peer-highlight", Boolean(number && block.dataset.shared === number));
    }
}

const gridEventTarget = (target) => target?.closest?.("#grid .ev") || null;
for (const [type, field, leaving] of [
    ["pointerover", "hoveredEvent", false],
    ["pointerout", "hoveredEvent", true],
    ["focusin", "focusedEvent", false],
    ["focusout", "focusedEvent", true],
]) {
    document.addEventListener(type, (event) => {
        const block = gridEventTarget(leaving ? event.relatedTarget : event.target);
        if (state[field] === block) return;
        state[field] = block;
        // Keyboard navigation takes precedence over a stationary pointer.
        if (field === "focusedEvent" && !leaving && block) state.hoveredEvent = null;
        highlightSharedEvents();
    });
}

async function loadCalendarOptions() {
    try {
        const response = await fetch(withToken("/api/calendars"));
        const payload = await response.json();
        $("calendar-options").innerHTML = (payload.items || [])
            .map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.summary)}</option>`)
            .join("");
        $("calendar-hint").textContent = payload.error
            ? `候補の取得に失敗しました: ${errorDetail(payload.error)}`
            : "候補は自分のカレンダー一覧（gali list）です。他ユーザーのメールアドレスも直接入力できます。";
    } catch (error) {
        $("calendar-hint").textContent = `候補の取得に失敗しました: ${errorDetail(error)}`;
    }
}

async function addCalendar() {
    const input = $("add-input");
    const submitted = input.value;
    const ids = submitted
        .split(/[,\s]+/)
        .map((value) => value.trim())
        .filter(Boolean);
    if (!ids.length) return;
    try {
        await enqueueCalendarOperation(() => post("/api/calendars/add", { calendars: ids }));
        if (input.value === submitted) input.value = "";
    } catch (error) {
        $("calendar-hint").textContent = `追加に失敗しました: ${errorDetail(error)}`;
    }
}

function clearCalendarDropTarget() {
    const target = state.calendarDrag?.target;
    if (target) target.classList.remove("drop-before", "drop-after");
    if (state.calendarDrag) state.calendarDrag.target = null;
}

function cancelCalendarDrag() {
    const drag = state.calendarDrag;
    if (!drag) return;
    clearCalendarDropTarget();
    drag.source.classList.remove("dragging");
    state.calendarDrag = null;
}

function finishCalendarDrag() {
    if (!state.calendarDrag) return;
    cancelCalendarDrag();
    if (state.data) {
        renderChips(state.data);
        renderGrid(state.data);
    }
}

function calendarDropPosition(event, header) {
    const bounds = header.getBoundingClientRect();
    return event.clientX < bounds.left + bounds.width / 2 ? "before" : "after";
}

document.addEventListener("dragstart", (event) => {
    const header = event.target.closest("#grid th[data-order-calendar]");
    if (!header || !event.dataTransfer) return;
    state.calendarDrag = { id: header.dataset.orderCalendar, source: header, target: null };
    header.classList.add("dragging");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", "gali-calendar");
});

document.addEventListener("dragover", (event) => {
    if (!state.calendarDrag) return;
    const header = event.target.closest("#grid th[data-order-calendar]");
    clearCalendarDropTarget();
    if (!header) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    if (header.dataset.orderCalendar === state.calendarDrag.id) return;
    const position = calendarDropPosition(event, header);
    header.classList.add(`drop-${position}`);
    state.calendarDrag.target = header;
});

document.addEventListener("drop", (event) => {
    if (!state.calendarDrag) return;
    const header = event.target.closest("#grid th[data-order-calendar]");
    const id = state.calendarDrag.id;
    if (header) event.preventDefault();
    const targetId = header?.dataset.orderCalendar;
    const position = header ? calendarDropPosition(event, header) : null;
    finishCalendarDrag();
    if (targetId && targetId !== id) moveCalendar({ id, targetId, position });
});

document.addEventListener("dragend", finishCalendarDrag);

document.addEventListener("click", (domEvent) => {
    const target = domEvent.target;

    const nav = target.closest("[data-nav]");
    if (nav) {
        post("/api/navigate", { direction: nav.dataset.nav });
        return;
    }
    const view = target.closest("#view-group button");
    if (view) {
        patchSettings({ view: view.dataset.view });
        return;
    }
    const move = target.closest("[data-move-calendar]");
    if (move) {
        moveCalendar({ id: move.dataset.moveCalendar, direction: move.dataset.direction });
        return;
    }
    const remove = target.closest("[data-remove]");
    if (remove) {
        const id = remove.dataset.remove;
        enqueueCalendarOperation(() => post("/api/calendars/remove", { calendars: [id] })).catch((error) => {
            calendarOrderMessage(`カレンダーを削除できませんでした: ${errorDetail(error)}`, true);
        });
        return;
    }
    const tab = target.closest("#adjust-tabs button");
    if (tab) {
        selectTab(tab.dataset.tab);
        return;
    }
    const whatIf = target.closest("[data-whatif]");
    if (whatIf) {
        runWhatIf(Number(whatIf.dataset.whatif));
        return;
    }
    const block = target.closest(".ev");
    if (block) {
        domEvent.stopPropagation();
        showPopover(block);
        return;
    }
    if (!target.closest("#popover")) hidePopover();
});

document.addEventListener("keydown", (domEvent) => {
    if (domEvent.key === "Escape") hidePopover();
});

// The popover is position:fixed, so it would detach from its event block on scroll.
window.addEventListener("scroll", hidePopover, true);
window.addEventListener("resize", hidePopover);

$("date-picker-toggle").addEventListener("click", openDateCalendar);
$("date-calendar-close").addEventListener("click", () => $("date-calendar").close());
$("date-calendar").addEventListener("close", () => {
    state.dateCalendar = null;
    $("date-picker-toggle").setAttribute("aria-expanded", "false");
    const active = document.activeElement;
    if (!active || active === document.body || $("date-calendar").contains(active)) $("date-picker-toggle").focus();
});
$("date-calendar-prev").addEventListener("click", () => moveDateCalendarMonths(-1, false));
$("date-calendar-next").addEventListener("click", () => moveDateCalendarMonths(1, false));
$("date-calendar-today").addEventListener("click", () => chooseCalendarDate(localDate(new Date())));
$("date-calendar-days").addEventListener("click", (event) => {
    const day = event.target.closest("button[data-picker-date]");
    if (day) return chooseCalendarDate(day.dataset.pickerDate);
});
$("date-calendar-days").addEventListener("keydown", (event) => {
    if (!state.dateCalendar || !event.target.closest("button[data-picker-date]")) return;
    const offsets = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (Object.hasOwn(offsets, event.key)) {
        event.preventDefault();
        moveDateCalendarDays(offsets[event.key]);
    } else if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        const day = new Date(`${state.dateCalendar.focus}T00:00:00Z`).getUTCDay();
        const offset = day;
        moveDateCalendarDays(event.key === "Home" ? -offset : 6 - offset);
    } else if (event.key === "PageUp" || event.key === "PageDown") {
        event.preventDefault();
        moveDateCalendarMonths((event.key === "PageUp" ? -1 : 1) * (event.shiftKey ? 12 : 1));
    }
});

$("refresh").addEventListener("click", () => post("/api/refresh", {}));
$("toggle-share").addEventListener("click", () => saveShareMode(!sharingMode()));
$("retry-share-mode").addEventListener("click", () => {
    if (state.shareFailure) return saveShareMode(state.shareFailure.target);
});

$("toggle-presets").addEventListener("click", (event) => {
    const panel = $("presets");
    panel.hidden = !panel.hidden;
    event.currentTarget.setAttribute("aria-expanded", String(!panel.hidden));
});

$("preset-select").addEventListener("change", () => {
    $("preset-delete-confirm").hidden = true;
    presetMessage("");
    if (state.data) renderPresets(state.data);
});

$("preset-name").addEventListener("input", () => {
    if (state.data) renderPresets(state.data);
});

$("save-preset").addEventListener("click", async () => {
    const input = $("preset-name");
    const submitted = input.value;
    const result = await postPreset("/api/presets/create", { name: submitted });
    if (!result) return;
    if (input.value === submitted) input.value = "";
    $("preset-select").value = result.preset.id;
    renderPresets(state.data);
    presetMessage(`「${result.preset.name}」を保存しました。`);
});

$("apply-preset").addEventListener("click", async () => {
    const result = await postPreset("/api/presets/apply", { id: $("preset-select").value });
    if (result) presetMessage(`「${result.preset.name}」のメンバーに切り替えました。`);
});

$("update-preset").addEventListener("click", async () => {
    const result = await postPreset("/api/presets/update", { id: $("preset-select").value });
    if (!result) return;
    $("preset-select").value = result.preset.id;
    $("preset-delete-confirm").hidden = true;
    renderPresets(state.data);
    presetMessage(`「${result.preset.name}」を現在のメンバーで更新しました。`);
});

$("delete-preset").addEventListener("click", () => {
    $("preset-delete-confirm").hidden = false;
    $("confirm-delete-preset").focus();
});

$("cancel-delete-preset").addEventListener("click", () => {
    $("preset-delete-confirm").hidden = true;
    $("delete-preset").focus();
});

$("confirm-delete-preset").addEventListener("click", async () => {
    const result = await postPreset("/api/presets/delete", { id: $("preset-select").value });
    if (!result) return;
    $("preset-delete-confirm").hidden = true;
    presetMessage(`「${result.preset.name}」を削除しました。`);
});

$("refresh-presets").addEventListener("click", async () => {
    const result = await postPreset("/api/presets/refresh", {});
    if (result) presetMessage("プリセット一覧を更新しました。");
});

$("toggle-settings").addEventListener("click", (domEvent) => {
    const panel = $("settings");
    panel.hidden = !panel.hidden;
    domEvent.currentTarget.setAttribute("aria-expanded", String(!panel.hidden));
    if (!panel.hidden) loadCalendarOptions();
});

function selectTab(name) {
    for (const button of document.querySelectorAll("#adjust-tabs button")) {
        button.setAttribute("aria-pressed", String(button.dataset.tab === name));
    }
    for (const id of ["candidates", "blockers", "shared"]) {
        $(`tab-${id}`).hidden = id !== name;
    }
}

async function runWhatIf(position) {
    const scan = state.data && state.data.scan;
    const meeting = scan && scan.sharedMeetings[position];
    if (!meeting) return;
    const id = meeting.keys.join("|");
    const scanId = state.scanId;
    state.whatIf.set(id, { pending: true });
    renderShared(scan);
    // A reply that arrives after the scan was replaced belongs to the old one.
    const settle = (value) => {
        if (state.scanId === scanId) state.whatIf.set(id, value);
    };
    try {
        const payload = await post("/api/whatif", { keys: meeting.keys });
        settle(payload && payload.whatIf ? payload.whatIf : { error: true });
    } catch {
        settle({ error: true });
    }
    renderShared(state.data && state.data.scan);
}

$("toggle-adjust").addEventListener("click", (domEvent) => {
    const panel = $("adjust");
    panel.hidden = !panel.hidden;
    domEvent.currentTarget.setAttribute("aria-expanded", String(!panel.hidden));
    if (!panel.hidden && !document.querySelector('#adjust-tabs button[aria-pressed="true"]')) selectTab("candidates");
});

const runScan = (force) =>
    post("/api/scan", {
        durationMinutes: Number($("scan-duration").value),
        weeks: Number($("scan-weeks").value),
        force,
    });

$("scan-btn").addEventListener("click", () => runScan(false));
$("scan-force").addEventListener("click", () => runScan(true));
$("scan-duration").addEventListener("change", (e) => patchSettings({ slotMinutes: Number(e.target.value) }, false));
$("scan-weeks").addEventListener("change", (e) => patchSettings({ scanWeeks: Number(e.target.value) }, false));
$("skip-holidays").addEventListener("change", (e) => patchSettings({ skipHolidays: e.target.checked }, false));
$("skip-policy").addEventListener("change", (e) => patchSettings({ skipPolicySlots: e.target.checked }, false));
$("away-busy").addEventListener("change", (e) => patchSettings({ treatAwayAsBusy: e.target.checked }, false));
$("weekdays-only").addEventListener("change", (e) => patchSettings({ scanWeekdaysOnly: e.target.checked }, false));
$("holiday-cal").addEventListener("change", (e) => patchSettings({ holidayCalendarId: e.target.value.trim() }, false));
$("policy-patterns").addEventListener("change", (e) =>
    patchSettings({ policyPatterns: e.target.value.split(/[,、]+/).map((v) => v.trim()).filter(Boolean) }, false),
);

$("add-btn").addEventListener("click", addCalendar);
$("add-input").addEventListener("keydown", (domEvent) => {
    if (domEvent.key === "Enter") addCalendar();
});

$("ref-mycals").addEventListener("change", (e) => patchSettings({ refMyCals: e.target.checked }));
$("show-diff").addEventListener("change", (e) => patchSettings({ showCompletionDiff: e.target.checked }));
$("show-declined").addEventListener("change", (e) => patchSettings({ showDeclined: e.target.checked }, false));
$("show-free").addEventListener("change", (e) => patchSettings({ showFreeSlots: e.target.checked }, false));
$("refs").addEventListener("change", (e) =>
    patchSettings({ refs: e.target.value.split(/[,\s]+/).filter(Boolean) }),
);
$("building").addEventListener("change", (e) => patchSettings({ building: e.target.value.trim() }));
$("work-start").addEventListener("change", (e) => patchSettings({ workStart: e.target.value }, false));
$("work-end").addEventListener("change", (e) => patchSettings({ workEnd: e.target.value }, false));

const stream = new EventSource(withToken("/events"));
stream.onmessage = (message) => {
    try {
        apply(JSON.parse(message.data));
    } catch {
        // Ignore malformed frames; the next push will resync.
    }
};

fetch(withToken("/api/bootstrap"))
    .then((response) => response.json())
    .then(apply)
    .catch(() => {});
