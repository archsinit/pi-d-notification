import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { plainText, truncate } from "./preview.mjs";

const execute = promisify(execFile);
const COMMAND_TIMEOUT = 1_500;

// NSWorkspace does not require System Events or Accessibility permission.
export const FOREGROUND_SCRIPT = `
ObjC.import("AppKit");
function run() {
  const app = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  if (!app || app.isNil()) return "null";
  return JSON.stringify({
    bundleId: ObjC.unwrap(app.bundleIdentifier),
    name: ObjC.unwrap(app.localizedName),
    pid: Number(app.processIdentifier)
  });
}`;

// Data is passed as an argument, never interpolated into AppleScript or a shell.
// Recheck the foreground PID just before requesting the notification.
export const NOTIFICATION_SCRIPT = `
ObjC.import("AppKit");
function run(argv) {
  const data = JSON.parse(argv[0]);
  const app = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  if (!app || app.isNil() || Number(app.processIdentifier) !== data.frontmostPid) {
    return "focus-changed";
  }
  const sender = Application.currentApplication();
  sender.includeStandardAdditions = true;
  sender.displayNotification(data.body, {
    withTitle: data.title,
    soundName: "Pop"
  });
  return "requested";
}`;

export async function runCommand(file, args, { signal, timeout = COMMAND_TIMEOUT } = {}) {
  signal?.throwIfAborted();
  const { stdout } = await execute(file, args, {
    encoding: "utf8",
    maxBuffer: 256 * 1024,
    timeout,
    killSignal: "SIGKILL",
    signal,
    windowsHide: true,
  });
  return stdout.trim();
}

export function terminalKind(env = process.env) {
  const program = (env.TERM_PROGRAM ?? "").toLowerCase();
  if (program === "wezterm" || program === "ghostty") return program;
  // Do not trust inherited WezTerm variables inside another known terminal.
  if (program) return "unsupported";
  if (env.WEZTERM_PANE !== undefined) return "wezterm";
  if (env.GHOSTTY_RESOURCES_DIR) return "ghostty";
  return "unsupported";
}

export function weztermCli(env = process.env, exists = existsSync) {
  if (env.PI_D_NOTIFY_WEZTERM_CLI) return env.PI_D_NOTIFY_WEZTERM_CLI;
  const directories = [env.WEZTERM_EXECUTABLE_DIR,
    env.WEZTERM_EXECUTABLE ? dirname(env.WEZTERM_EXECUTABLE) : undefined];
  for (const directory of directories) {
    // WEZTERM_EXECUTABLE often points to wezterm-gui, which has no `cli` command.
    if (directory && exists(join(directory, "wezterm"))) return join(directory, "wezterm");
  }
  return "wezterm";
}

function isWezterm(app) {
  return app.bundleId === "com.github.wez.wezterm" || app.name?.toLowerCase() === "wezterm";
}

export function paneFocus(app, clients, paneId) {
  if (!Array.isArray(clients) || !/^\d+$/.test(paneId ?? "")) return "unknown";
  const pane = Number(paneId);
  if (!Number.isSafeInteger(pane)) return "unknown";
  const client = clients.find((item) => item?.pid === app.pid);
  if (!Number.isSafeInteger(client?.focused_pane_id) || client.focused_pane_id < 0) return "unknown";
  return client.focused_pane_id === pane ? "focused" : "away";
}

export async function weztermFocus({ env = process.env, signal, run = runCommand } = {}) {
  signal?.throwIfAborted();
  const app = JSON.parse(await run("/usr/bin/osascript", ["-l", "JavaScript", "-e", FOREGROUND_SCRIPT], { signal }));
  if (!app || !Number.isSafeInteger(app.pid) || app.pid <= 0 ||
      (typeof app.bundleId !== "string" && typeof app.name !== "string")) {
    return { state: "unknown" };
  }
  if (!isWezterm(app)) return { state: "away", frontmostPid: app.pid };
  const clients = JSON.parse(await run(weztermCli(env), ["cli", "list-clients", "--format", "json"], { signal }));
  return { state: paneFocus(app, clients, env.WEZTERM_PANE), frontmostPid: app.pid };
}

export function ghosttySequence({ title, body }) {
  // OSC fields must not contain delimiters or terminal control sequences.
  const field = (value, limit) => truncate(plainText(value).replaceAll(";", ","), limit);
  return `\x1b]777;notify;${field(title, 100)};${field(body, 500)}\x1b\\`;
}

export async function notifyUser(payload, {
  env = process.env,
  platform = process.platform,
  signal,
  run = runCommand,
  stdout = process.stdout,
} = {}) {
  signal?.throwIfAborted();
  if (platform !== "darwin") return { status: "unsupported-platform" };
  if (!stdout.isTTY) return { status: "not-interactive" };
  const terminal = terminalKind(env);
  if (terminal === "ghostty") {
    // Ghostty attaches this notification to the originating surface and suppresses
    // its banner AND sound when that surface is focused. No stdin listeners.
    signal?.throwIfAborted();
    await new Promise((resolve, reject) => {
      stdout.write(ghosttySequence(payload), (error) => error ? reject(error) : resolve());
    });
    return { status: "delegated", terminal };
  }
  if (terminal !== "wezterm") return { status: "unsupported-terminal" };
  const focus = await weztermFocus({ env, signal, run });
  signal?.throwIfAborted();
  if (focus.state !== "away") return { status: focus.state, terminal };
  const result = await run("/usr/bin/osascript", ["-l", "JavaScript", "-e", NOTIFICATION_SCRIPT,
    "--", JSON.stringify({ title: payload.title, body: payload.body, frontmostPid: focus.frontmostPid })], { signal });
  return { status: result === "requested" ? "requested" : "focus-changed", terminal };
}
