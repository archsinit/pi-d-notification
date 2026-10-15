import assert from "node:assert/strict";
import test from "node:test";
import {
  FOREGROUND_SCRIPT, NOTIFICATION_SCRIPT, ghosttySequence, notifyUser,
  paneFocus, runCommand, terminalKind, weztermCli, weztermFocus,
} from "../src/terminals.mjs";

const wezEnv = { TERM_PROGRAM: "WezTerm", WEZTERM_PANE: "30", PI_D_NOTIFY_WEZTERM_CLI: "/fake/wezterm" };
const wezApp = { bundleId: "com.github.wez.wezterm", name: "WezTerm", pid: 42 };
const otherApp = { bundleId: "org.example.browser", name: "Browser", pid: 70 };
const tty = { isTTY: true, write(_text, callback) { callback(); } };
function runner(...replies) {
  const calls = [];
  const run = async (...args) => {
    calls.push(args);
    assert.ok(replies.length, "unexpected subprocess");
    const result = replies.shift();
    if (result instanceof Error) throw result;
    return typeof result === "string" ? result : JSON.stringify(result);
  };
  return { run, calls };
}
const options = (run, extra = {}) => ({ env: wezEnv, platform: "darwin", stdout: tty, run, ...extra });
const payload = { title: "pi-d · project", body: "Done. Tests passed." };

test("terminal detection rejects stale variables inherited by other terminals", () => {
  assert.equal(terminalKind(wezEnv), "wezterm");
  assert.equal(terminalKind({ TERM_PROGRAM: "ghostty", WEZTERM_PANE: "30" }), "ghostty");
  assert.equal(terminalKind({ TERM_PROGRAM: "iTerm.app", WEZTERM_PANE: "30" }), "unsupported");
  assert.equal(terminalKind({ WEZTERM_PANE: "0" }), "wezterm");
  assert.equal(terminalKind({ GHOSTTY_RESOURCES_DIR: "/resources" }), "ghostty");
  assert.equal(terminalKind({}), "unsupported");
});

test("resolves the CLI beside wezterm-gui, with an explicit override available", () => {
  const env = { WEZTERM_EXECUTABLE: "/Applications/WezTerm.app/Contents/MacOS/wezterm-gui" };
  assert.equal(weztermCli(env, () => true), "/Applications/WezTerm.app/Contents/MacOS/wezterm");
  assert.equal(weztermCli(env, () => false), "wezterm");
  assert.equal(weztermCli({ WEZTERM_EXECUTABLE_DIR: "/wez", ...env }, () => true), "/wez/wezterm");
  assert.equal(weztermCli({ PI_D_NOTIFY_WEZTERM_CLI: "/custom/wezterm" }), "/custom/wezterm");
});

test("matches the focused pane to the foreground GUI process, not any client", () => {
  const clients = [{ pid: 99, focused_pane_id: 30 }, { pid: 42, focused_pane_id: 31 }];
  assert.equal(paneFocus(wezApp, clients, "30"), "away");
  assert.equal(paneFocus(wezApp, clients, "31"), "focused");
  assert.equal(paneFocus(wezApp, [{ pid: 42, focused_pane_id: 0 }], "0"), "focused");
  for (const value of [undefined, "", "bad", "-1", "9007199254740993"]) {
    assert.equal(paneFocus(wezApp, clients, value), "unknown");
  }
  assert.equal(paneFocus(wezApp, [], "30"), "unknown");
  assert.equal(paneFocus(wezApp, {}, "30"), "unknown");
  assert.equal(paneFocus(wezApp, [{ pid: 42, focused_pane_id: null }], "30"), "unknown");
});

test("another foreground application counts as away without needing the WezTerm CLI", async () => {
  const { run, calls } = runner(otherApp);
  assert.deepEqual(await weztermFocus({ env: wezEnv, run }), { state: "away", frontmostPid: 70 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "/usr/bin/osascript");
  assert.equal(calls[0][1][3], FOREGROUND_SCRIPT);
});

test("a focused originating pane sends neither a notification nor sound", async () => {
  const { run, calls } = runner(wezApp, [{ pid: 42, focused_pane_id: 30 }]);
  assert.deepEqual(await notifyUser(payload, options(run)), { status: "focused", terminal: "wezterm" });
  assert.equal(calls.length, 2);
  assert.equal(calls[1][0], "/fake/wezterm");
  assert.deepEqual(calls[1][1], ["cli", "list-clients", "--format", "json"]);
});

test("another pane/tab/window requests a native macOS notification", async () => {
  const { run, calls } = runner(wezApp, [{ pid: 42, focused_pane_id: 99 }], "requested");
  assert.deepEqual(await notifyUser(payload, options(run)), { status: "requested", terminal: "wezterm" });
  const args = calls[2][1];
  assert.deepEqual(args.slice(0, 5), ["-l", "JavaScript", "-e", NOTIFICATION_SCRIPT, "--"]);
  assert.deepEqual(JSON.parse(args[5]), { ...payload, frontmostPid: 42 });
});

test("reply text is an argument, never executable script or shell text", async () => {
  const dangerous = { title: 'pi-d "test"', body: '"; do shell script "BAD"; $(echo BAD)\nnext line' };
  const { run, calls } = runner(otherApp, "requested");
  await notifyUser(dangerous, options(run));
  assert.equal(calls[1][1][3], NOTIFICATION_SCRIPT);
  assert.deepEqual(JSON.parse(calls[1][1][5]), { ...dangerous, frontmostPid: 70 });
});

test("focus uncertainty is suppressed and foreground changes cancel dispatch", async () => {
  for (const replies of [[null], [{ pid: "bad" }], [wezApp, []]]) {
    const { run } = runner(...replies);
    assert.equal((await notifyUser(payload, options(run))).status, "unknown");
  }
  const { run } = runner(otherApp, "focus-changed");
  assert.equal((await notifyUser(payload, options(run))).status, "focus-changed");
});

test("Ghostty delegates focus-aware banner and sound suppression, without subprocesses", async () => {
  const frames = [];
  const stdout = { isTTY: true, write(frame, callback) { frames.push(frame); callback(); } };
  const run = () => assert.fail("Ghostty must not launch an AppleScript or CLI");
  assert.deepEqual(await notifyUser(payload, options(run, { env: { TERM_PROGRAM: "ghostty" }, stdout })),
    { status: "delegated", terminal: "ghostty" });
  assert.deepEqual(frames, ["\x1b]777;notify;pi-d · project;Done. Tests passed.\x1b\\"]);
});

test("OSC fields cannot inject delimiters, bells, clipboard escapes, or new notifications", () => {
  const frame = ghosttySequence({ title: "pi-d;fake\x07", body: "ok\x1b]52;c;PRIVATE\x07;tail\u009c\nend" });
  assert.equal(frame, "\x1b]777;notify;pi-d,fake;ok,tail end\x1b\\");
  assert.equal((frame.match(/\x1b]/g) ?? []).length, 1);
});

test("non-macOS, redirected output, and unsupported terminals have no effects", async () => {
  const run = () => assert.fail("unexpected subprocess");
  assert.equal((await notifyUser(payload, options(run, { platform: "linux" }))).status, "unsupported-platform");
  assert.equal((await notifyUser(payload, options(run, { stdout: { isTTY: false } }))).status, "not-interactive");
  assert.equal((await notifyUser(payload, options(run, { env: { TERM_PROGRAM: "other" } }))).status, "unsupported-terminal");
});

test("cancellation before or during a focus query prevents notification dispatch", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(notifyUser(payload, options(() => assert.fail(), { signal: controller.signal })), { name: "AbortError" });
  const during = new AbortController();
  let calls = 0;
  await assert.rejects(notifyUser(payload, options(async () => {
    calls += 1; during.abort(); return JSON.stringify(otherApp);
  }, { signal: during.signal })), { name: "AbortError" });
  assert.equal(calls, 1);
});

test("subprocess runner preserves arguments without invoking a shell", async () => {
  const argument = '$(echo NEVER_EXECUTE); "quoted"';
  assert.equal(await runCommand(process.execPath, ["-e", "process.stdout.write(process.argv[1])", argument]), argument);
});

test("subprocess runner has a bounded timeout and honors cancellation", async () => {
  await assert.rejects(runCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeout: 40 }),
    (error) => error.killed === true && error.signal === "SIGKILL");
  const controller = new AbortController();
  const pending = runCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
});
