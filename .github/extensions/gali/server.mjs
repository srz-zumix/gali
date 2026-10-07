// Loopback HTTP server that backs the canvas iframe.
//
// One server per canvas instance (ephemeral port, 127.0.0.1 only). The iframe
// talks to it over plain fetch + Server-Sent Events; there is no privileged
// bridge to the host.

import { createServer } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { listCalendars, GaliError } from "./gali.mjs";
import { getProfileState, shiftAnchor, todayISO } from "./state.mjs";

const UI_DIR = path.dirname(fileURLToPath(new URL("./ui/index.html", import.meta.url)));

const CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
};

let calendarCache = null;

async function getAvailableCalendars({ force = false } = {}) {
    if (calendarCache && !force && Date.now() - calendarCache.at < 5 * 60_000) {
        return calendarCache.items;
    }
    const items = await listCalendars();
    calendarCache = { at: Date.now(), items };
    return items;
}

function sendJson(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Length": Buffer.byteLength(payload),
    });
    res.end(payload);
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on("data", (chunk) => {
            size += chunk.length;
            if (size > 1024 * 1024) {
                reject(new Error("request body too large"));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            if (!text) {
                resolve({});
                return;
            }
            try {
                resolve(JSON.parse(text));
            } catch (error) {
                reject(error);
            }
        });
        req.on("error", reject);
    });
}

async function serveStatic(res, relativePath) {
    const resolved = path.resolve(UI_DIR, `.${path.posix.normalize(`/${relativePath}`)}`);
    if (!resolved.startsWith(UI_DIR)) {
        sendJson(res, 403, { error: "forbidden" });
        return;
    }
    try {
        const body = await readFile(resolved);
        res.writeHead(200, {
            "Content-Type": CONTENT_TYPES[path.extname(resolved)] || "application/octet-stream",
            "Cache-Control": "no-store",
            "Content-Length": body.length,
        });
        res.end(body);
    } catch {
        sendJson(res, 404, { error: "not found" });
    }
}

function attachEventStream(req, res, state, streams) {
    res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
    });
    const send = (payload) => {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };
    send(state.toJSON());
    const unsubscribe = state.subscribe(send);
    const keepAlive = setInterval(() => res.write(": ping\n\n"), 25_000);
    const cleanup = () => {
        clearInterval(keepAlive);
        unsubscribe();
        streams.delete(close);
    };
    // Held open forever by design, so shutting the instance down has to end it
    // explicitly: `server.close()` waits for every live request.
    const close = () => {
        cleanup();
        res.end();
    };
    streams.add(close);
    req.on("close", cleanup);
    req.on("error", cleanup);
}

/**
 * Loopback is not authentication: any page in any browser on this machine can
 * reach this port. Requests must carry the per-instance token handed to the
 * iframe, must target the loopback authority we are listening on (DNS
 * rebinding presents a foreign Host), and must not be a cross-origin form-style
 * POST that would skip the preflight.
 */
function authorize(req, url, { token, port }) {
    const host = String(req.headers.host || "");
    const expected = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
    if (!expected.has(host)) return "bad host";

    const origin = req.headers.origin;
    if (origin && !expected.has(new URL(origin).host)) return "cross-origin request";

    const supplied = url.searchParams.get("token") || String(req.headers["x-gali-token"] || "");
    const a = Buffer.from(supplied);
    const b = Buffer.from(token);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return "bad token";

    if (req.method === "POST" && !String(req.headers["content-type"] || "").startsWith("application/json")) {
        return "unsupported content type";
    }
    return null;
}

function toMessage(error) {
    if (error instanceof GaliError) return error.message;
    return String((error && error.message) || error);
}

async function handleRequest(req, res, { profile, instanceId, token, port, streams }) {
    const url = new URL(req.url, "http://127.0.0.1");
    const route = url.pathname;

    if (route === "/" || route === "/index.html") {
        await serveStatic(res, "index.html");
        return;
    }
    if (!route.startsWith("/api/") && route !== "/events") {
        await serveStatic(res, route);
        return;
    }

    const denied = authorize(req, url, { token, port });
    if (denied) {
        sendJson(res, 403, { error: `forbidden: ${denied}` });
        return;
    }

    const state = await getProfileState(profile);

    if (route === "/events") {
        attachEventStream(req, res, state, streams);
        return;
    }

    if (route === "/api/bootstrap") {
        sendJson(res, 200, { instanceId, ...state.toJSON() });
        return;
    }

    if (route === "/api/calendars") {
        try {
            const items = await getAvailableCalendars({ force: url.searchParams.get("refresh") === "1" });
            sendJson(res, 200, { items });
        } catch (error) {
            sendJson(res, 200, { items: [], error: toMessage(error) });
        }
        return;
    }

    if (req.method !== "POST") {
        sendJson(res, 405, { error: "method not allowed" });
        return;
    }

    let body;
    try {
        body = await readBody(req);
    } catch (error) {
        sendJson(res, 400, { error: toMessage(error) });
        return;
    }

    try {
        if (route === "/api/settings") {
            await state.updateSettings(body.settings || {}, { refresh: body.refresh !== false });
        } else if (route === "/api/calendars/remove") {
            // Sent as an operation, not a replacement list: a list computed in
            // the browser can be built on settings that have since changed.
            const remove = new Set((Array.isArray(body.calendars) ? body.calendars : []).map((id) => String(id)));
            await state.updateSettings((settings) => ({
                calendars: settings.calendars.filter((entry) => !remove.has(entry.id)),
            }));
        } else if (route === "/api/refresh") {
            await state.refresh({ force: true });
        } else if (route === "/api/scan") {
            if (!state.settings.calendars.length) {
                sendJson(res, 200, { ...state.toJSON(), error: "カレンダーが設定されていません。" });
                return;
            }
            await state.scanAvailability(
                {
                    durationMinutes: body.durationMinutes,
                    weeks: body.weeks,
                    from: body.from,
                },
                { force: Boolean(body.force) },
            );
        } else if (route === "/api/whatif") {
            const result = state.whatIf(Array.isArray(body.keys) ? body.keys : []);
            sendJson(res, 200, { whatIf: result, ...state.toJSON() });
            return;
        } else if (route === "/api/navigate") {
            const direction = body.direction === "prev" ? -1 : body.direction === "next" ? 1 : 0;
            // Computed inside the lock: two quick "next" clicks must advance
            // two pages, not race onto the same starting anchor.
            await state.updateSettings((settings) => ({
                anchor: direction === 0 ? todayISO() : shiftAnchor(settings, direction),
            }));
        } else {
            sendJson(res, 404, { error: "not found" });
            return;
        }
        sendJson(res, 200, state.toJSON());
    } catch (error) {
        sendJson(res, 200, { ...state.toJSON(), error: toMessage(error) });
    }
}

export async function startServer({ profile, instanceId }) {
    const token = randomUUID();
    const streams = new Set();
    let port = 0;
    const server = createServer((req, res) => {
        handleRequest(req, res, { profile, instanceId, token, port, streams }).catch((error) => {
            if (!res.headersSent) sendJson(res, 500, { error: toMessage(error) });
            else res.end();
        });
    });
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            server.removeListener("error", reject);
            resolve();
        });
    });
    const address = server.address();
    port = typeof address === "object" && address ? address.port : 0;
    const close = () =>
        new Promise((resolve) => {
            for (const end of [...streams]) end();
            server.close(() => resolve());
            // Keep-alive sockets would hold the close open as well.
            server.closeAllConnections?.();
        });
    return {
        server,
        close,
        url: `http://127.0.0.1:${port}/?profile=${encodeURIComponent(profile)}&token=${token}`,
    };
}
