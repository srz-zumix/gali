import { randomUUID } from "node:crypto";
import { watch } from "node:fs";
import { chmod, mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const COPILOT_HOME = process.env.COPILOT_HOME || path.join(homedir(), ".copilot");
const PRESET_DIR = path.join(COPILOT_HOME, "gali-calendar", "member-presets");
export const PRESET_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const MAX_PRESET_NAME_LENGTH = 80;
const UPDATE_MARKER_PATTERN = /^\.update-(pending|committed)-([0-9a-f-]{36})-([0-9a-f-]{36})\.json$/;

export class PresetError extends Error {
    constructor(code, message) {
        super(message);
        this.name = "PresetError";
        this.code = code;
    }
}

function normalizeName(value) {
    if (typeof value !== "string") {
        throw new PresetError("invalid_preset", "プリセット名を入力してください。");
    }
    const name = value.trim().normalize("NFC");
    if (!name || name.length > MAX_PRESET_NAME_LENGTH) {
        throw new PresetError("invalid_preset", `プリセット名は 1〜${MAX_PRESET_NAME_LENGTH} 文字で入力してください。`);
    }
    return name;
}

function normalizeMembers(value) {
    if (!Array.isArray(value) || !value.length) {
        throw new PresetError("invalid_preset", "保存するメンバーを少なくとも 1 人追加してください。");
    }
    const seen = new Set();
    return value.map((entry) => {
        if (!entry || typeof entry.id !== "string" || typeof entry.label !== "string") {
            throw new PresetError("invalid_preset", "プリセットのメンバーが不正です。");
        }
        const id = entry.id.trim();
        if (!id || seen.has(id)) {
            throw new PresetError("invalid_preset", "プリセットに空または重複したカレンダー ID があります。");
        }
        seen.add(id);
        return { id, label: entry.label };
    });
}

function copyPreset(preset) {
    return { ...preset, calendars: preset.calendars.map((entry) => ({ ...entry })) };
}

function storageError(error) {
    if (error instanceof PresetError) return error;
    return new PresetError("preset_storage", `プリセットの保存データを操作できません: ${error.message || error}`);
}

async function removeIfPresent(file) {
    try {
        await unlink(file);
    } catch (error) {
        if (error.code !== "ENOENT") throw error;
    }
}

export class PresetStore {
    constructor(directory = PRESET_DIR) {
        this.directory = directory;
        this.presets = [];
        this.error = null;
        this.listeners = new Set();
        this.queue = Promise.resolve();
        this.initializing = null;
        this.watcher = null;
        this.reloadTimer = null;
    }

    #enqueue(task) {
        const next = this.queue.then(task, task);
        this.queue = next.then(() => {}, () => {});
        return next;
    }

    #notify() {
        for (const listener of this.listeners) {
            try {
                listener();
            } catch (error) {
                process.stderr.write(`Preset subscriber failed: ${error.message || error}\n`);
            }
        }
    }

    #setError(error) {
        this.error = storageError(error).message;
        this.#notify();
    }

    subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    snapshot() {
        return this.presets.map(copyPreset);
    }

    #fileFor(id) {
        if (typeof id !== "string" || !PRESET_ID_PATTERN.test(id)) {
            throw new PresetError("invalid_preset", "プリセット ID が不正です。");
        }
        return path.join(this.directory, `${id}.json`);
    }

    #temporaryFor(id) {
        this.#fileFor(id);
        return path.join(this.directory, `.${id}.tmp`);
    }

    #markerFor(phase, previousId, nextId) {
        this.#fileFor(previousId);
        this.#fileFor(nextId);
        return path.join(this.directory, `.update-${phase}-${previousId}-${nextId}.json`);
    }

    async #readRecord(id) {
        const file = this.#fileFor(id);
        let text;
        try {
            text = await readFile(file, "utf8");
        } catch (error) {
            if (error.code === "ENOENT") {
                throw new PresetError("preset_not_found", "プリセットが見つかりません。一覧を更新してください。");
            }
            throw error;
        }
        try {
            const value = JSON.parse(text);
            if (!value || value.id !== id) throw new Error("ID mismatch");
            return { id, name: normalizeName(value.name), calendars: normalizeMembers(value.calendars) };
        } catch (error) {
            throw new PresetError("preset_storage", `プリセット ${id} の保存データが壊れています: ${error.message}`);
        }
    }

    async #reload() {
        let files = await readdir(this.directory, { withFileTypes: true });
        let recovered = false;
        for (const file of files) {
            const match = UPDATE_MARKER_PATTERN.exec(file.name);
            if (!match || !PRESET_ID_PATTERN.test(match[2]) || !PRESET_ID_PATTERN.test(match[3])) continue;
            await this.#finishUpdate(match[2], match[3]);
            recovered = true;
        }
        if (recovered) files = await readdir(this.directory, { withFileTypes: true });
        const presets = [];
        for (const file of files) {
            if (!file.name.endsWith(".json")) continue;
            const id = file.name.slice(0, -5);
            if (!PRESET_ID_PATTERN.test(id)) continue;
            if (!file.isFile()) throw new Error(`プリセット ${id} は通常のファイルではありません。`);
            try {
                presets.push(await this.#readRecord(id));
            } catch (error) {
                // Another process may remove a preset between readdir and readFile.
                if (error instanceof PresetError && error.code === "preset_not_found") continue;
                throw error;
            }
        }
        presets.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
        const changed = JSON.stringify(presets) !== JSON.stringify(this.presets) || this.error !== null;
        this.presets = presets;
        this.error = null;
        if (changed) this.#notify();
    }

    #watch() {
        if (this.watcher) return;
        this.watcher = watch(this.directory, { persistent: false }, (_event, file) => {
            if (file && !String(file).endsWith(".json")) return;
            clearTimeout(this.reloadTimer);
            this.reloadTimer = setTimeout(() => {
                this.refresh().catch((error) => this.#setError(error));
            }, 50);
            this.reloadTimer.unref?.();
        });
        this.watcher.on("error", (error) => {
            this.watcher.close();
            this.watcher = null;
            this.#setError(error);
        });
    }

    async initialize() {
        if (!this.initializing) {
            const attempt = this.#enqueue(async () => {
                try {
                    await mkdir(this.directory, { recursive: true, mode: 0o700 });
                    await chmod(this.directory, 0o700);
                    this.#watch();
                    await this.#reload();
                    return true;
                } catch (error) {
                    this.#setError(error);
                    return false;
                }
            });
            this.initializing = attempt;
            const succeeded = await attempt;
            if (!succeeded && this.initializing === attempt) this.initializing = null;
            return succeeded;
        }
        const succeeded = await this.initializing;
        if (succeeded && !this.watcher) {
            this.initializing = null;
            return this.initialize();
        }
        return succeeded;
    }

    async #ensureInitialized() {
        if (!(await this.initialize())) throw new PresetError("preset_storage", this.error);
    }

    async refresh() {
        await this.#ensureInitialized();
        return this.#enqueue(async () => {
            try {
                await this.#reload();
                return this.snapshot();
            } catch (error) {
                this.#setError(error);
                throw storageError(error);
            }
        });
    }

    async #prepare(preset) {
        const temporary = this.#temporaryFor(preset.id);
        let handle;
        let created = false;
        try {
            handle = await open(temporary, "wx", 0o600);
            created = true;
            await handle.writeFile(`${JSON.stringify(preset, null, 2)}\n`, "utf8");
            await handle.close();
            handle = null;
        } catch (error) {
            try {
                if (handle) await handle.close();
                if (created) await removeIfPresent(temporary);
            } catch (cleanupError) {
                throw new AggregateError([error, cleanupError], "プリセットの保存と一時ファイルの削除に失敗しました。");
            }
            throw error;
        }
    }

    async #finishUpdate(previousId, nextId) {
        const pending = this.#markerFor("pending", previousId, nextId);
        const committed = this.#markerFor("committed", previousId, nextId);
        try {
            await rename(pending, committed);
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
        }
        try {
            await rename(this.#temporaryFor(nextId), this.#fileFor(nextId));
        } catch (error) {
            // Another process may already have published or deleted the replacement.
            if (error.code !== "ENOENT") throw error;
        }
        await removeIfPresent(committed);
    }

    async #mutate(task) {
        await this.#ensureInitialized();
        return this.#enqueue(async () => {
            try {
                await this.#reload();
                const result = await task();
                await this.#reload();
                return result;
            } catch (error) {
                if (!(error instanceof PresetError) || error.code === "preset_storage") this.#setError(error);
                throw storageError(error);
            }
        });
    }

    async create(name, calendars) {
        const cleanName = normalizeName(name);
        const members = normalizeMembers(calendars);
        return this.#mutate(async () => {
            const preset = { id: randomUUID(), name: cleanName, calendars: members };
            await this.#prepare(preset);
            try {
                await rename(this.#temporaryFor(preset.id), this.#fileFor(preset.id));
            } catch (error) {
                try {
                    await removeIfPresent(this.#temporaryFor(preset.id));
                } catch (cleanupError) {
                    throw new AggregateError([error, cleanupError], "プリセットの保存と一時ファイルの削除に失敗しました。");
                }
                throw error;
            }
            return copyPreset(preset);
        });
    }

    async update(id, calendars) {
        const members = normalizeMembers(calendars);
        return this.#mutate(async () => {
            const previous = await this.#readRecord(id);
            const preset = { id: randomUUID(), name: previous.name, calendars: members };
            await this.#prepare(preset);
            try {
                await rename(this.#fileFor(id), this.#markerFor("pending", id, preset.id));
            } catch (error) {
                try {
                    await removeIfPresent(this.#temporaryFor(preset.id));
                } catch (cleanupError) {
                    throw new AggregateError([error, cleanupError], "プリセットの更新と取り消しに失敗しました。");
                }
                if (error.code === "ENOENT") {
                    throw new PresetError("preset_conflict", "プリセットが別の操作で更新または削除されました。");
                }
                throw error;
            }
            try {
                await this.#finishUpdate(id, preset.id);
            } catch (error) {
                throw new PresetError(
                    "preset_storage",
                    `プリセットの更新処理を完了できませんでした。一覧を再読込してください: ${error.message || error}`,
                );
            }
            return copyPreset(preset);
        });
    }

    async remove(id) {
        return this.#mutate(async () => {
            const preset = await this.#readRecord(id);
            try {
                await unlink(this.#fileFor(id));
            } catch (error) {
                if (error.code === "ENOENT") {
                    throw new PresetError("preset_conflict", "プリセットが別の操作で更新または削除されました。");
                }
                throw error;
            }
            return copyPreset(preset);
        });
    }

    async get(id) {
        await this.#ensureInitialized();
        return this.#enqueue(async () => {
            try {
                return copyPreset(await this.#readRecord(id));
            } catch (error) {
                throw storageError(error);
            }
        });
    }

    close() {
        clearTimeout(this.reloadTimer);
        this.watcher?.close();
        this.watcher = null;
    }
}

export const presetStore = new PresetStore();
