// Canvas renderer. Talks to the loopback server over fetch + SSE and draws a
// day/3-day/week grid of the calendars gali can see.

import { HOUR_HEIGHT, MIN_GRID_HEIGHT, computeGeometry, clampGridHeight } from "./layout.mjs";
import { buildSharedEventGroups, calendarEventKey } from "./meetings.mjs";

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];
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
};

/* ---------------- helpers ---------------- */

const escapeHtml = (value) =>
    String(value ?? "").replace(
        /[&<>"']/g,
        (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char],
    );

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
    return `${start.getFullYear()}年 ${formatDayLabel(first)} – ${formatDayLabel(last)}`;
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
    apply(payload);
    return payload;
}

const patchSettings = (patch, refresh = true) => post("/api/settings", { settings: patch, refresh });

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

function renderSharedBadge(group, calendar) {
    if (!group) return "";
    const label = escapeHtml(sharedLabel(group, calendar));
    return `<span class="shared-badge" title="${label}" aria-label="${label}">同${group.number}</span>`;
}

function renderEventBlock(placed, calendar, geometry, settings) {
    const { event, startMin, endMin, lane, laneCount } = placed;
    const top = ((startMin - geometry.startMinute) / 60) * HOUR_HEIGHT;
    const height = Math.max(14, ((endMin - startMin) / 60) * HOUR_HEIGHT - 2);
    const classes = ["ev"];
    if (!event.detailsVisible) classes.push("masked");
    if (event.transparency === "transparent") classes.push("transparent");
    if (event.responseStatus === "declined") classes.push("declined");

    const title = event.detailsVisible ? event.summary : "予定あり（詳細非公開）";
    const badge = renderCompletionBadge(event, settings);
    const shared = state.sharedEvents.get(calendarEventKey(calendar.id, event.id));
    if (shared && height < 18) classes.push("compact");
    const timeText = `${placed.continuesBefore ? "…" : ""}${hhmm(startMin)}${placed.continuesAfter ? "…" : ""}`;

    return `<button type="button" class="${classes.join(" ")}"
        style="top:${top}px;height:${height}px;left:${(lane / laneCount) * 100}%;width:${100 / laneCount}%;--ev-color:${calendar.color};--ev-fill:${hexToRgba(calendar.color, 0.22)}"
        data-cal="${escapeHtml(calendar.id)}" data-ev="${escapeHtml(event.id)}"
        ${shared ? `data-shared="${shared.number}"` : ""}
        title="${escapeHtml(`${hhmm(startMin)}-${hhmm(endMin)} ${title}${event.completed ? `\n${completionLabel(event)}` : ""}${shared ? `\n${sharedLabel(shared, calendar)}` : ""}`)}"
        >${renderSharedBadge(shared, calendar)}<span class="t">${escapeHtml(timeText)}</span> ${escapeHtml(title)}${badge}</button>`;
}

function renderAllDay(event, calendar, settings) {
    const classes = ["ev"];
    if (!event.detailsVisible) classes.push("masked");
    if (event.responseStatus === "declined") classes.push("declined");
    const title = event.detailsVisible ? event.summary : "予定あり（詳細非公開）";
    const badge = renderCompletionBadge(event, settings);
    const shared = state.sharedEvents.get(calendarEventKey(calendar.id, event.id));
    return `<button type="button" class="${classes.join(" ")}"
        style="--ev-color:${calendar.color};--ev-fill:${hexToRgba(calendar.color, 0.22)}"
        data-cal="${escapeHtml(calendar.id)}" data-ev="${escapeHtml(event.id)}"
        ${shared ? `data-shared="${shared.number}"` : ""}
        title="${escapeHtml(`${title}${event.completed ? `\n${completionLabel(event)}` : ""}${shared ? `\n${sharedLabel(shared, calendar)}` : ""}`)}"
        >${renderSharedBadge(shared, calendar)}${escapeHtml(title)}${badge}</button>`;
}

function renderGrid(data) {
    const grid = $("grid");
    const snapshot = data.snapshot;
    const settings = data.settings;
    state.sharedEvents = buildSharedEventGroups(snapshot?.calendars || []);
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

    const calendars = snapshot.calendars;
    const days = snapshot.range.days;
    const today = localDate(new Date());

    const columns = [];
    for (const day of days) {
        for (const calendar of calendars) {
            const events = visibleEvents(calendar, settings);
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
                allDay: events.filter((event) => event.allDay && coversDay(event, day)),
            });
        }
    }

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
                              `<th class="owner" title="${escapeHtml(calendar.id)}"><span class="owner-name"><span class="dot" style="background:${calendar.color}"></span>${escapeHtml(calendar.label)}</span></th>`,
                      )
                      .join(""),
              )
              .join("")}</tr>`
        : "";

    const allDayCells = columns
        .map(
            (column, index) =>
                `<td class="${index % calendars.length === 0 ? "daystart" : ""}"><div class="allday">${column.allDay
                    .map((event) => renderAllDay(event, column.calendar, settings))
                    .join("")}</div></td>`,
        )
        .join("");

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
            <tr><td class="gutter"><div class="allday"></div></td>${allDayCells}</tr>
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
    if (!data.settings.calendars.length) {
        chips.innerHTML = '<span class="empty">カレンダー未設定</span>';
        return;
    }
    chips.innerHTML = data.settings.calendars
        .map((entry) => {
            const found = snapshot && snapshot.calendars.find((calendar) => calendar.id === entry.id);
            const color = found ? found.color : "var(--gali-muted)";
            const label = (found && found.label) || entry.label || entry.id;
            let meta = "";
            if (found && found.error) meta = '<span class="meta error">取得エラー</span>';
            else if (found) {
                const hidden = found.stats.hidden ? ` / 非公開 ${found.stats.hidden}` : "";
                const declined = found.stats.declined
                    ? ` / 辞退 ${found.stats.declined}${data.settings.showDeclined ? "" : "（非表示）"}`
                    : "";
                meta = `<span class="meta">${found.stats.total} 件${hidden}${declined}</span>`;
            }
            return `<span class="chip" title="${escapeHtml(`${entry.id}${found && found.error ? `\n${found.error}` : ""}`)}">
                <i class="dot" style="background:${color}"></i>
                <span class="name">${escapeHtml(label)}</span>${meta}
                <button type="button" data-remove="${escapeHtml(entry.id)}" title="削除">×</button>
            </span>`;
        })
        .join("");
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

function renderCandidates(scan) {
    const pane = $("tab-candidates");
    if (!scan) {
        pane.innerHTML = `<p class="hint">「候補を探す」で ${$("scan-weeks").value} 週間先まで全員の空きを探します。</p>`;
        return;
    }
    const hints = (scan.hint || []).map((text) => `<li>${escapeHtml(text)}</li>`).join("");
    if (!scan.candidates.length) {
        pane.innerHTML = `<p class="empty">${escapeHtml(scan.from)} 〜 ${escapeHtml(scan.until)} に ${scan.durationMinutes}分の空きはありません。</p>${hints ? `<ul class="notes">${hints}</ul>` : ""}`;
        return;
    }
    const rows = scan.candidates
        .slice(0, 30)
        .map((candidate, position) => {
            const reasons = candidate.reasons.map((text) => `<li>${escapeHtml(text)}</li>`).join("");
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

function renderBlockers(scan) {
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
                <td class="num">${blocker.awaySlots}</td>
            </tr>`,
        )
        .join("");
    const near = scan.nearMiss
        .slice(0, 25)
        .map(
            (slot) => `<li class="${slot.movable ? "movable" : "immovable"}">
                <span class="near-when">${escapeHtml(formatDayLabel(slot.day))} ${escapeHtml(slot.start)}–${escapeHtml(slot.end)}</span>
                <span class="near-who">${escapeHtml(slot.blocker)}</span>
                <span class="near-what">${slot.events.map((event) => `${escapeHtml(event.title)}<i>${escapeHtml(KIND_LABELS[event.kind] || event.kind)}</i>`).join(" / ")}</span>
            </li>`,
        )
        .join("");
    pane.innerHTML = `<table class="blockers">
            <thead><tr><th>参加者</th><th class="num">塞いだ枠</th><th class="num">単独原因</th><th class="num">終日ブロック</th></tr></thead>
            <tbody>${rows}</tbody>
        </table>
        <h4>あと1人空けば成立する枠</h4>
        ${near ? `<ul class="near-miss">${near}</ul>` : '<p class="hint">該当なし</p>'}
        <p class="hint">緑＝会議なのでリスケ交渉の余地あり / 赤＝終日ブロックなので会議を動かしても空きません。</p>`;
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

function renderShared(scan) {
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
                    <span class="shared-title">${escapeHtml(meeting.title)}</span>
                    ${meeting.recurring ? '<span class="tag">定期</span>' : ""}
                    ${everyone ? '<span class="tag ok">全員</span>' : ""}
                </div>
                <div class="shared-meta">${escapeHtml(meeting.attendees.join("・"))} / ${meeting.occurrences}回 / ${escapeHtml(String(meeting.firstStart).slice(0, 16).replace("T", " "))}</div>
                <button type="button" class="whatif" data-whatif="${position}">動かしたら何枠空く？</button>
                ${whatIfMarkup(meeting.keys.join("|"))}
            </li>`;
        })
        .join("");
    pane.innerHTML = `<ul class="shared">${rows}</ul>`;
}

function renderAdjust(data) {
    renderScanProgress(data);
    renderCandidates(data.scan);
    renderBlockers(data.scan);
    renderShared(data.scan);
    const busy = Boolean(data.scanProgress);
    $("scan-btn").disabled = busy;
    $("scan-force").disabled = busy;
}

function renderStatus(data) {
    const status = $("status");
    const errors = [];
    if (data.error) errors.push(data.error);
    for (const calendar of (data.snapshot && data.snapshot.calendars) || []) {
        if (calendar.error) errors.push(`${calendar.label}: ${calendar.error}`);
    }
    if (errors.length) {
        status.className = "status error";
        status.textContent = errors.join("\n");
        return;
    }
    status.className = "status";
    if (data.loading) {
        status.textContent = "gali で取得中…";
    } else if (data.snapshot) {
        const at = new Date(data.snapshot.fetchedAt);
        const refs = data.snapshot.usingReferences ? " / 参照カレンダーで非公開予定を補完" : "";
        status.textContent = `最終取得 ${pad2(at.getHours())}:${pad2(at.getMinutes())}${refs}`;
    } else {
        status.textContent = "";
    }
}

function apply(data) {
    if (!data || !data.settings) return;
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
    renderSettings(data);
    renderChips(data);
    renderStatus(data);
    renderGrid(data);
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
            status.textContent = `表示領域の高さを保存できませんでした: ${error.message}`;
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

    const popover = $("popover");
    popover.innerHTML = `<h3>${escapeHtml(event.detailsVisible ? event.summary : "予定あり（詳細非公開）")}</h3><dl>${rows.join("")}</dl>`;
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
};

/* ---------------- wiring ---------------- */

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
            ? `候補の取得に失敗しました: ${payload.error}`
            : "候補は自分のカレンダー一覧（gali list）です。他ユーザーのメールアドレスも直接入力できます。";
    } catch (error) {
        $("calendar-hint").textContent = String(error);
    }
}

function addCalendar() {
    const input = $("add-input");
    const ids = input.value
        .split(/[,\s]+/)
        .map((value) => value.trim())
        .filter(Boolean);
    if (!ids.length) return;
    const current = state.data ? state.data.settings.calendars : [];
    input.value = "";
    patchSettings({ calendars: [...current, ...ids.map((id) => ({ id, label: "" }))] });
}

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
    const remove = target.closest("[data-remove]");
    if (remove) {
        const id = remove.dataset.remove;
        post("/api/calendars/remove", { calendars: [id] });
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

$("refresh").addEventListener("click", () => post("/api/refresh", {}));

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
