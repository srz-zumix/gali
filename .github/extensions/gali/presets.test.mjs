import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import { MAX_PRESET_NAME_LENGTH, PresetStore } from "./presets.mjs";

const execFileAsync = promisify(execFile);
const members = (...ids) => ids.map((id) => ({ id, label: id.toUpperCase() }));

async function waitFor(predicate) {
    const deadline = Date.now() + 5000;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error("preset update was not observed");
        await delay(25);
    }
}

async function makeStores(t, count = 1) {
    const directory = await mkdtemp(path.join(tmpdir(), "gali-presets-test-"));
    const stores = Array.from({ length: count }, () => new PresetStore(path.join(directory, "presets")));
    t.after(async () => {
        for (const store of stores) store.close();
        await Promise.all(stores.map((store) => store.queue));
        await rm(directory, { recursive: true, force: true });
    });
    await Promise.all(stores.map((store) => store.initialize()));
    return { directory, stores };
}

test("presets persist privately, preserve order and labels, and can be updated or removed", async (t) => {
    const { directory, stores } = await makeStores(t);
    const [store] = stores;
    const saved = await store.create("  チーム A  ", members("alice", "bob"));
    assert.equal(saved.name, "チーム A");
    assert.deepEqual(saved.calendars, members("alice", "bob"));
    assert.deepEqual(await store.refresh(), [saved]);

    if (process.platform !== "win32") {
        assert.equal((await stat(path.join(directory, "presets"))).mode & 0o777, 0o700);
        assert.equal((await stat(path.join(directory, "presets", `${saved.id}.json`))).mode & 0o777, 0o600);
    }

    const reopened = new PresetStore(path.join(directory, "presets"));
    t.after(() => reopened.close());
    assert.equal(await reopened.initialize(), true);
    assert.deepEqual(reopened.snapshot(), [saved]);

    const updated = await store.update(saved.id, members("carol", "alice"));
    assert.notEqual(updated.id, saved.id);
    assert.equal(updated.name, saved.name);
    assert.deepEqual(updated.calendars, members("carol", "alice"));
    await assert.rejects(store.get(saved.id), { code: "preset_not_found" });
    assert.deepEqual(await store.get(updated.id), updated);
    assert.deepEqual(await store.remove(updated.id), updated);
    assert.deepEqual(await store.refresh(), []);
    assert.deepEqual(await readdir(path.join(directory, "presets")), []);
});

test("invalid inputs and corrupt preset files are reported without changing valid data", async (t) => {
    const { directory, stores } = await makeStores(t);
    const [store] = stores;
    const saved = await store.create("valid", members("alice"));
    for (const name of ["", "  ", "x".repeat(MAX_PRESET_NAME_LENGTH + 1), null]) {
        await assert.rejects(store.create(name, members("alice")), { code: "invalid_preset" });
    }
    for (const invalid of [[], [{ id: "", label: "" }], [{ id: "alice", label: 3 }], members("alice", "alice")]) {
        await assert.rejects(store.create("invalid", invalid), { code: "invalid_preset" });
    }
    await assert.rejects(store.get("../profiles/default"), { code: "invalid_preset" });
    assert.deepEqual(await store.refresh(), [saved]);

    await writeFile(path.join(directory, "presets", `${saved.id}.json`), "{broken");
    await assert.rejects(store.refresh(), { code: "preset_storage" });
    assert.match(store.error, /保存データが壊れています/);
});

test("changes from another store are reflected without changing an existing preset's members", async (t) => {
    const { stores } = await makeStores(t, 2);
    const [first, second] = stores;
    const saved = await first.create("共有", members("alice", "bob"));
    await waitFor(() => second.snapshot().some((preset) => preset.id === saved.id));

    const updated = await second.update(saved.id, members("carol"));
    await waitFor(() => first.snapshot().some((preset) => preset.id === updated.id));
    assert.deepEqual(first.snapshot(), [updated]);
    await first.remove(updated.id);
    await waitFor(() => second.snapshot().length === 0);
});

test("incomplete updates are recovered without exposing uncommitted replacements or resurrecting deletions", async (t) => {
    const { directory, stores } = await makeStores(t);
    const [store] = stores;
    const root = path.join(directory, "presets");
    const original = await store.create("チーム", members("alice"));
    const replacement = { id: randomUUID(), name: original.name, calendars: members("bob") };
    const temporary = path.join(root, `.${replacement.id}.tmp`);
    const pending = path.join(root, `.update-pending-${original.id}-${replacement.id}.json`);
    const committed = path.join(root, `.update-committed-${original.id}-${replacement.id}.json`);
    await writeFile(temporary, JSON.stringify(replacement), { mode: 0o600 });

    assert.deepEqual(await store.refresh(), [original]);
    await assert.rejects(store.get(replacement.id), { code: "preset_not_found" });
    await rename(path.join(root, `${original.id}.json`), pending);
    await assert.rejects(store.remove(original.id), { code: "preset_not_found" });
    assert.deepEqual(await store.refresh(), [replacement]);
    assert.deepEqual(await readdir(root), [`${replacement.id}.json`]);

    await writeFile(committed, JSON.stringify(original), { mode: 0o600 });
    await unlink(path.join(root, `${replacement.id}.json`));
    assert.deepEqual(await store.refresh(), []);
    assert.deepEqual(await readdir(root), []);
});

const childScript = `
    import { PresetStore } from ${JSON.stringify(new URL("./presets.mjs", import.meta.url).href)};
    const [directory, operation, id, member] = process.argv.slice(1);
    const store = new PresetStore(directory);
    try {
        const calendars = [{ id: member, label: member }];
        const preset = operation === "create" ? await store.create("同名", calendars)
            : operation === "update" ? await store.update(id, calendars)
            : await store.remove(id);
        process.stdout.write(JSON.stringify({ ok: true, preset }));
    } catch (error) {
        process.stdout.write(JSON.stringify({ ok: false, code: error.code }));
    } finally {
        store.close();
    }
`;

async function child(directory, operation, id, member) {
    const { stdout } = await execFileAsync(process.execPath, [
        "--input-type=module", "-e", childScript, directory, operation, id || "", member || "",
    ]);
    return JSON.parse(stdout);
}

test("concurrent processes preserve same-name creations and reject competing updates or deletion", async (t) => {
    const { directory, stores } = await makeStores(t);
    const [store] = stores;
    const root = path.join(directory, "presets");
    const created = await Promise.all([
        child(root, "create", "", "alice"),
        child(root, "create", "", "bob"),
    ]);
    assert.ok(created.every((result) => result.ok));
    assert.equal((await store.refresh()).length, 2);
    assert.deepEqual(
        new Set(store.snapshot().map((preset) => preset.calendars[0].id)),
        new Set(["alice", "bob"]),
    );

    const original = created[0].preset;
    const updates = await Promise.all([
        child(root, "update", original.id, "carol"),
        child(root, "update", original.id, "dave"),
    ]);
    assert.equal(updates.filter((result) => result.ok).length, 1);
    assert.ok(updates.some((result) => ["preset_not_found", "preset_conflict"].includes(result.code)));
    let remaining = await store.refresh();
    assert.equal(remaining.length, 2);
    const updated = updates.find((result) => result.ok).preset;
    assert.ok(remaining.some((preset) => preset.id === updated.id));

    const updateAndDelete = await Promise.all([
        child(root, "update", updated.id, "erin"),
        child(root, "remove", updated.id, ""),
    ]);
    assert.equal(updateAndDelete.filter((result) => result.ok).length, 1);
    remaining = await store.refresh();
    assert.equal(remaining.length, updateAndDelete[0].ok ? 2 : 1);
});
