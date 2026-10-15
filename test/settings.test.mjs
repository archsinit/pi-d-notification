import assert from "node:assert/strict";
import test from "node:test";
import { BELL, MUTED_BELL, createControls, environmentEnabled, notificationSettings } from "../src/settings.mjs";

function fixture({ state, env = {}, signal = new AbortController().signal } = {}) {
  const Settings = { definition: notificationSettings }, notices = [];
  let value = structuredClone(state), commits = 0, reads = 0, line = Promise.resolve();
  const api = {
    signal, context: { abortSignal: signal }, notify: (message) => notices.push(message),
    harness: {
      async snapshot(token, context) {
        assert.equal(token, Settings); context.abortSignal?.throwIfAborted(); reads++;
        return structuredClone(value);
      },
      commit(change, context) {
        const work = line.then(async () => {
          context.abortSignal?.throwIfAborted();
          const draft = structuredClone(value ?? notificationSettings.initial());
          const result = await change({ doc: async (token) => { assert.equal(token, Settings); return draft; } });
          context.abortSignal?.throwIfAborted(); value = draft; commits++;
          return result;
        });
        line = work.catch(() => {});
        return work;
      },
    },
  };
  const controls = createControls(Settings, { env }), command = controls.commands[0];
  return { api, controls, command, notices, get value() { return value; }, get commits() { return commits; }, get reads() { return reads; } };
}

const on = [{ text: BELL, tone: "gold", strikethrough: false }];
const off = [{ text: MUTED_BELL, tone: "dim", strikethrough: true }];

test("settings are native session state and the default gold bell does not create a document", async () => {
  assert.equal(notificationSettings.kind, "pi-d-notification.settings");
  assert.equal(notificationSettings.scope, "session"); assert.equal(notificationSettings.version, 1);
  assert.deepEqual(notificationSettings.initial(), { enabled: true });
  const f = fixture();
  assert.deepEqual(await f.controls.footer(f.api), on);
  assert.equal(f.value, undefined); assert.equal(f.commits, 0); assert.equal(f.reads, 1);
  assert(BELL.endsWith("\ufe0e")); assert(MUTED_BELL.endsWith("\ufe0e"));
});

test("the bare command toggles atomically, while on/off are explicit and idempotent", async () => {
  const f = fixture();
  assert.equal(f.command.name, "notifications"); assert.equal(f.command.argumentHint, "[on|off]");
  await f.command.execute("", f.api);
  assert.deepEqual(f.value, { enabled: false }); assert.deepEqual(await f.controls.footer(f.api), off);
  assert.equal(f.notices.at(-1), "Notifications off for this session.");
  await f.command.execute("", f.api); assert.deepEqual(f.value, { enabled: true });
  for (const argument of ["off", "off", "on", "on"]) {
    await f.command.execute(argument, f.api);
    assert.equal(f.value.enabled, argument === "on");
  }
  await Promise.all([f.command.execute("", f.api), f.command.execute("", f.api)]);
  assert.deepEqual(f.value, { enabled: true }); assert.deepEqual(await f.controls.footer(f.api), on);
});

test("on/off completion is static and invalid arguments do not touch state", async () => {
  const f = fixture();
  assert.deepEqual(f.command.complete("").map((item) => item.value), ["on", "off"]);
  assert.deepEqual(f.command.complete("of"), [{ value: "off", label: "off" }]);
  assert.deepEqual(f.command.complete("invalid"), []);
  for (const argument of ["yes", "on off", "ON", "toggle"]) {
    await assert.rejects(f.command.execute(argument, f.api), /Use \/notifications/);
  }
  assert.equal(f.value, undefined); assert.equal(f.commits, 0); assert.equal(f.reads, 0); assert.deepEqual(f.notices, []);
});

test("environment disable wins over session on, explains the override and leaves the saved preference intact", async () => {
  for (const disabled of ["0", "false"]) {
    const env = { PI_D_NOTIFY: disabled }, f = fixture({ env });
    assert.equal(environmentEnabled(env), false);
    assert.deepEqual(await f.controls.footer(f.api), off);
    await f.command.execute("on", f.api);
    assert.deepEqual(f.value, { enabled: true }); assert.deepEqual(await f.controls.footer(f.api), off);
    assert.match(f.notices.at(-1), /PI_D_NOTIFY disables alerts/);
    delete env.PI_D_NOTIFY;
    assert.deepEqual(await f.controls.footer(f.api), on);
  }
});

test("cancellation and failed native writes do not publish a success notice or replace the preference", async () => {
  const controller = new AbortController(), f = fixture({ state: { enabled: false }, signal: controller.signal });
  controller.abort(); await assert.rejects(f.command.execute("on", f.api), { name: "AbortError" });
  assert.deepEqual(f.value, { enabled: false }); assert.equal(f.commits, 0); assert.deepEqual(f.notices, []);
  const g = fixture({ state: { enabled: false } });
  g.api.harness.commit = async () => { throw new Error("Store unavailable."); };
  await assert.rejects(g.command.execute("on", g.api), /Store unavailable/);
  assert.deepEqual(g.value, { enabled: false }); assert.deepEqual(g.notices, []);
});

test("footer read failures propagate to the host without creating or overwriting settings", async () => {
  const f = fixture(); f.api.harness.snapshot = async () => { throw new Error("Read failed."); };
  await assert.rejects(f.controls.footer(f.api), /Read failed/);
  assert.equal(f.value, undefined); assert.equal(f.commits, 0);
});
