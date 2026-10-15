import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { FOREGROUND_SCRIPT, NOTIFICATION_SCRIPT } from "../src/terminals.mjs";

// Execute the exact JXA sources with fake Objective-C/Application bridges. This
// validates the dispatch branch without ever asking macOS to display anything.
function execute(script, app, data) {
  const notifications = [];
  const sender = {
    includeStandardAdditions: false,
    displayNotification(body, options) {
      assert.equal(this.includeStandardAdditions, true, "JXA requires Standard Additions for displayNotification");
      notifications.push({ body, ...JSON.parse(JSON.stringify(options)) });
    },
  };
  const result = runInNewContext(`${script}\nrun(args);`, {
    ObjC: { import() {}, unwrap: (value) => value },
    $: { NSWorkspace: { sharedWorkspace: { frontmostApplication: app } } },
    Application: { currentApplication: () => sender },
    args: [JSON.stringify(data)],
  });
  return { result, notifications };
}
const app = {
  processIdentifier: 42,
  bundleIdentifier: "com.github.wez.wezterm",
  localizedName: "WezTerm",
  isNil: () => false,
};

test("NSWorkspace bridge returns the expected focus information", () => {
  const { result, notifications } = execute(FOREGROUND_SCRIPT, app);
  assert.deepEqual(JSON.parse(result), { bundleId: "com.github.wez.wezterm", name: "WezTerm", pid: 42 });
  assert.deepEqual(notifications, []);
  assert.equal(execute(FOREGROUND_SCRIPT, null).result, "null");
});

test("native JXA dispatch enables Standard Additions and requests exactly one Pop notification", () => {
  const { result, notifications } = execute(NOTIFICATION_SCRIPT, app, {
    frontmostPid: 42, title: 'pi-d · "project"', body: 'Done. $(not a command)',
  });
  assert.equal(result, "requested");
  assert.deepEqual(notifications, [{ body: 'Done. $(not a command)', withTitle: 'pi-d · "project"', soundName: "Pop" }]);
});

test("native dispatch rechecks foreground PID and skips if focus changes or disappears", () => {
  for (const foreground of [app, null, { ...app, isNil: () => true }]) {
    const { result, notifications } = execute(NOTIFICATION_SCRIPT, foreground, { frontmostPid: -1 });
    assert.equal(result, "focus-changed");
    assert.deepEqual(notifications, []);
  }
});
