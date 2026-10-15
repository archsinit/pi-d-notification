import assert from "node:assert/strict";
import test from "node:test";
import { createOnYield } from "../src/notification.mjs";

const answer = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "**Done.** Tests passed." }] };
const context = { abortSignal: undefined };
function fixture(extra = {}) {
  const notifications = [], errors = [], memos = new Map();
  const api = {
    conversationId: 0,
    async memo(name, candidate) {
      if (!memos.has(name)) memos.set(name, candidate);
      return memos.get(name);
    },
  };
  const settings = {
    rootConversationId: 0,
    env: {},
    platform: "darwin",
    readWorkspace: async () => "/saved/workspace/project",
    notify: async (...args) => { notifications.push(args); return { status: "requested" }; },
    onError: (error) => errors.push(error),
    ...extra,
  };
  return { api, notifications, errors, memos, settings, onYield: createOnYield(settings) };
}

test("final-answer hook is side-effect-only and uses the saved workspace", async () => {
  const f = fixture();
  assert.equal(await f.onYield(answer, f.api, context), undefined);
  assert.equal(f.notifications.length, 1);
  assert.deepEqual(f.notifications[0][0], { title: "pi-d · project", body: "Done. Tests passed." });
  assert.equal(f.memos.size, 1);
});

test("repeated/recovered invocations do not replay a notification", async () => {
  const f = fixture();
  await f.onYield(answer, f.api, context);
  await createOnYield(f.settings)(answer, f.api, context);
  assert.equal(f.notifications.length, 1);
});

test("concurrent invocations cannot both claim the same generation", async () => {
  const f = fixture();
  await Promise.all([f.onYield(answer, f.api, context), f.onYield(answer, f.api, context)]);
  assert.equal(f.notifications.length, 1);
});

test("a focused skip is persisted rather than turning into an alert after recovery", async () => {
  let attempts = 0;
  const f = fixture({ notify: async () => { attempts += 1; return { status: "focused" }; } });
  await f.onYield(answer, f.api, context);
  await createOnYield(f.settings)(answer, f.api, context);
  assert.equal(attempts, 1);
});

test("muted replies are durably skipped and unmuting cannot replay them", async () => {
  let enabled = false, workspaceReads = 0, settingReads = 0;
  const f = fixture({
    readEnabled: async () => { settingReads++; return enabled; },
    readWorkspace: async () => { workspaceReads++; return "/project"; },
  });
  await f.onYield(answer, f.api, context);
  assert.equal(f.notifications.length, 0); assert.equal(workspaceReads, 0); assert.equal(f.memos.size, 1);
  enabled = true; await createOnYield(f.settings)(answer, f.api, context);
  assert.equal(f.notifications.length, 0); assert.equal(settingReads, 1); assert.deepEqual(f.errors, []);
  const next = fixture({ readEnabled: f.settings.readEnabled });
  await next.onYield(answer, next.api, context); assert.equal(next.notifications.length, 1);
});

test("a mute applied during preparation is rechecked before dispatch", async () => {
  let enabled = true;
  const f = fixture({ readEnabled: async () => enabled, readWorkspace: async () => { enabled = false; return "/project"; } });
  await f.onYield(answer, f.api, context);
  assert.equal(f.notifications.length, 0); assert.equal(f.memos.size, 1); assert.deepEqual(f.errors, []);
});

test("delivery receives a live settings guard for its final check after focus detection", async () => {
  let enabled = true, checks = 0, attempts = 0;
  const f = fixture({ readEnabled: async () => { checks++; return enabled; }, notify: async (_payload, options) => {
    attempts++; enabled = false; assert.equal(await options.shouldNotify(), false);
  } });
  await f.onYield(answer, f.api, context);
  assert.equal(attempts, 1); assert.equal(checks, 3); assert.deepEqual(f.errors, []);
});

test("tool rounds, failures, empty answers, and child conversations are ignored", async () => {
  const f = fixture();
  for (const message of [
    { ...answer, stopReason: "error" },
    { ...answer, stopReason: "aborted" },
    { ...answer, content: [] },
    { ...answer, content: [{ type: "thinking", thinking: "PRIVATE" }] },
    { ...answer, stopReason: "toolUse", content: [{ type: "toolCall", arguments: { private: true } }] },
  ]) await f.onYield(message, f.api, context);
  await f.onYield(answer, { ...f.api, conversationId: 99 }, context);
  assert.equal(f.notifications.length, 0);
  assert.equal(f.memos.size, 0);
});

test("disabled and unsupported-platform hooks never read or write native state", async () => {
  for (const extra of [{ env: { PI_D_NOTIFY: "0" } }, { env: { PI_D_NOTIFY: "false" } }, { platform: "linux" }]) {
    const f = fixture({ ...extra, readEnabled: async () => assert.fail("Disabled hooks must not read settings.") });
    await f.onYield(answer, f.api, context);
    assert.deepEqual(f.errors, []);
    assert.equal(f.notifications.length, 0);
    assert.equal(f.memos.size, 0);
  }
});

test("notification, focus, workspace, and memo errors never escape the hook", async () => {
  const problem = new Error("permission denied");
  for (const extra of [
    { notify: async () => { throw problem; } },
    { readWorkspace: async () => { throw problem; } },
    { readEnabled: async () => { throw problem; } },
  ]) {
    const f = fixture(extra);
    await assert.doesNotReject(f.onYield(answer, f.api, context));
    assert.deepEqual(f.errors, [problem]);
  }
  const f = fixture();
  f.api.memo = async () => { throw problem; };
  await assert.doesNotReject(f.onYield(answer, f.api, context));
  assert.deepEqual(f.errors, [problem]);
  assert.equal(f.notifications.length, 0);
  const g = fixture({ notify: async () => { throw problem; }, onError: () => { throw problem; } });
  await assert.doesNotReject(g.onYield(answer, g.api, context));
});

test("failed settings reads skip delivery and are not replayed", async () => {
  const problem = new Error("Settings unavailable.");
  const f = fixture({ readEnabled: async () => { throw problem; } });
  await f.onYield(answer, f.api, context); await f.onYield(answer, f.api, context);
  assert.deepEqual(f.errors, [problem]); assert.equal(f.notifications.length, 0); assert.equal(f.memos.size, 1);
});

test("a failed external attempt is not replayed", async () => {
  let attempts = 0;
  const f = fixture({ notify: async () => { attempts += 1; throw new Error("unavailable"); } });
  await f.onYield(answer, f.api, context);
  await f.onYield(answer, f.api, context);
  assert.equal(attempts, 1);
});

test("cancellation before the hook or while preparing a notification is silent", async () => {
  const controller = new AbortController();
  controller.abort();
  const f = fixture();
  await f.onYield(answer, f.api, { abortSignal: controller.signal });
  assert.equal(f.memos.size, 0);
  const during = new AbortController();
  const g = fixture({ readWorkspace: async () => { during.abort(); return "/project"; } });
  await g.onYield(answer, g.api, { abortSignal: during.signal });
  assert.equal(g.notifications.length, 0);
  assert.equal(g.errors.length, 0);
});

test("cancellation during a settings read silently suppresses delivery", async () => {
  const controller = new AbortController();
  const f = fixture({ readEnabled: async () => { controller.abort(); return true; } });
  await f.onYield(answer, f.api, { abortSignal: controller.signal });
  assert.equal(f.notifications.length, 0); assert.deepEqual(f.errors, []); assert.equal(f.memos.size, 1);
});

test("preview length is bounded with a safe default for invalid settings", async () => {
  for (const [setting, expected] of [["20", 20], ["0", 160], ["NaN", 160], ["999999", 160]]) {
    const f = fixture({ env: { PI_D_NOTIFY_PREVIEW_LENGTH: setting } });
    await f.onYield({ ...answer, content: [{ type: "text", text: "x".repeat(600) }] }, f.api, context);
    assert.equal(f.notifications[0][0].body.length, expected);
  }
});
