import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { createOnYield } from "../src/notification.mjs";
import { BELL, MUTED_BELL, environmentEnabled, notificationSettings, sessionEnabled } from "../src/settings.mjs";

const host = process.env.PI_D_HOST_PATH;
const hostTest = { skip: host ? false : "Set PI_D_HOST_PATH to an existing pi-d checkout for native SDK/UI tests" };
const entry = fileURLToPath(new URL("../index.mjs", import.meta.url));
let loaded;
function loadHost() {
  return loaded ??= (async () => {
    const directory = resolve(host), require = createRequire(join(directory, "package.json"));
    const { createJiti } = require("jiti");
    const loader = createJiti(import.meta.url, {
      fsCache: false, interopDefault: false,
      nativeModules: ["@earendil-works/pi-durable", "@earendil-works/pi-ai", "@earendil-works/pi-tui", "@earendil-works/chord", "typebox"],
    });
    const [coding, session, chat, commands, completion, resources, models, terminal, sdk, chord, tui, faux] = await Promise.all([
      ...["src/coding.ts", "src/session.ts", "src/chat.ts", "src/commands.ts", "src/completion.ts", "src/resources.ts", "test/models.ts", "test/terminal.ts"].map((path) => loader.import(join(directory, path))),
      ...["@earendil-works/pi-durable", "@earendil-works/chord/context", "@earendil-works/pi-tui", "@earendil-works/pi-ai/providers/faux"].map((name) => import(loader.esmResolve(name, pathToFileURL(join(directory, "package.json")).href))),
    ]);
    return { ...coding, ...session, ...chat, ...commands, ...completion, ...resources, ...models, ...terminal, sdk, chord, tui, fauxProvider: faux };
  })();
}

async function until(predicate, detail = () => "") {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await delay(10); }
  assert.fail("Timed out waiting for notification UI.\n" + detail());
}

async function fixture() {
  const host = await loadHost(), { sdk, chord } = host;
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pi-d-notification-")));
  const Settings = sdk.defineDoc(notificationSettings), context = chord.BACKGROUND_CONTEXT;
  const resources = new host.Resources(join(directory, "config"), [], directory);
  const registry = await host.codingRegistry(resources, [entry]);
  const extension = registry.snapshot().extension("pi-d-notification");
  const notifications = [], errors = [];
  // Exercise native generation and settings with fake delivery only. Never launch a notification process or write OSC.
  registry.install({ ...extension, hooks: [sdk.hook(sdk.GenerationTask, { onYield: createOnYield({
    rootConversationId: sdk.ROOT_CONVERSATION_ID, env: process.env, platform: "darwin",
    readEnabled: async (api, context) => sessionEnabled(await api.snapshot(Settings, context)),
    readWorkspace: async (api, context) => (await api.snapshot(sdk.AgentDoc, api.conversationId, context))?.cwd,
    notify: async (payload, options) => { if (await options.shouldNotify()) notifications.push(payload); },
    onError: (error) => errors.push(error),
  }) })] });
  const { models, faux } = host.testModels();
  const terminal = new host.TestTerminal(110, 30);
  let app;
  const first = join(directory, "first.sqlite"), second = join(directory, "second.sqlite");
  const make = async (file) => {
    const chat = await host.openPersistentChat(file, models, { defaults: { model: host.model }, registry, defaultCwd: directory, onLockLost: host.lockLost });
    chat.command = host.chatCommands(chat, models, resources); chat.completion = host.commandCompletion(chat, models, resources);
    chat.sessions = { newFile: async () => second, list: async () => ({ choices: [], diagnostics: [] }), open: make };
    return chat;
  };
  return {
    host, Settings, context, terminal, notifications, errors, models, faux, first, second, make, extension,
    get app() { return app; },
    mount: async (file = first) => { app = await host.mountChat(await make(file), terminal, false); },
    send: async (text) => { app.ui.composer.editor.setText(text); terminal.send("\r"); await terminal.flush(); },
    close: async () => { try { await app?.close(); } finally { terminal.dispose(); await rm(directory, { recursive: true, force: true }); } },
  };
}

function assertBell(f, enabled) {
  const footer = f.terminal.text().split("\n").at(-1) ?? "";
  const glyph = (enabled ? BELL : MUTED_BELL).replace("\ufe0e", "");
  const index = footer.indexOf(glyph); assert(index >= 0, `Expected bell in footer: ${footer}`);
  const column = f.host.tui.visibleWidth(footer.slice(0, index));
  const cell = f.terminal.screen.buffer.active.getLine(f.terminal.rows - 1)?.getCell(column); assert(cell);
  assert.equal(!!cell.isStrikethrough(), !enabled);
  assert.equal(cell.getFgColor(), enabled ? 0xcbc06c : 0x66666f);
}

test("loads hooks, the local command and footer through the real host loader without modifying the host", hostTest, async () => {
  const { codingRegistry, sdk } = await loadHost();
  const registry = await codingRegistry({}, [entry]), extension = registry.snapshot().extension("pi-d-notification");
  assert.equal(extension.name, "pi-d-notification"); assert.equal(extension.hooks.length, 1);
  assert.equal(extension.hooks[0].task, sdk.GenerationTask.definition.name);
  assert.equal(typeof extension.hooks[0].handlers.onYield, "function");
  assert.equal(extension.piD.commands[0].name, "notifications"); assert.equal(typeof extension.piD.footer, "function");
  assert.equal(extension.tools, undefined); assert.equal(extension.tasks, undefined);
  await extension.hooks[0].handlers.onYield(
    { role: "assistant", stopReason: "stop", content: [] }, { conversationId: sdk.ROOT_CONVERSATION_ID }, { abortSignal: undefined },
  );
});

test("native commands, completion and bells persist across reset/reopen, stay session-local, and gate fake notifications", { ...hostTest, timeout: 15000 }, async (t) => {
  const f = await fixture(), capabilities = f.host.tui.getCapabilities();
  f.host.tui.setCapabilities({ ...capabilities, trueColor: true });
  try {
    await f.mount(); await f.terminal.flush();
    const effectiveOn = environmentEnabled();
    const toasts = t.mock.method(f.app.ui, "addExtensionToast"), notices = t.mock.method(f.app.ui, "setNotice");
    assertBell(f, effectiveOn);
    assert.equal(await f.app.chat.harness.snapshot(f.Settings, f.context), undefined, "Rendering must not create settings.");
    const suggest = (text) => f.app.chat.completion.getSuggestions([text], 0, text.length, { signal: new AbortController().signal, force: true });
    assert((await suggest("/noti"))?.items.some((item) => item.value === "notifications"));
    assert.deepEqual((await suggest("/notifications of"))?.items.map((item) => item.value), ["off"]);
    await f.send("/notifications"); await until(() => !f.app.ui.busy); await f.terminal.flush();
    assert.equal((await f.app.chat.harness.snapshot(f.Settings, f.context)).enabled, false); assertBell(f, false);
    assert.equal(toasts.mock.callCount(), 1);
    const [source, text, options] = toasts.mock.calls[0].arguments;
    assert.equal(source, "pi-d-notification /notifications"); assert.match(text, /^Notifications off for this session\./);
    assert.deepEqual(options, { type: effectiveOn ? "success" : "info" });
    assert.match(f.terminal.text(), /Notifications off for this session\./);
    const footer = f.terminal.text().split("\n").at(-1) ?? "";
    assert.match(footer, /ready/); assert.match(footer, /ctx ~/); assert(!footer.includes("Notifications"));
    assert(notices.mock.calls.every((call) => !call.arguments[0].startsWith("Notifications")));
    await f.send("/notifications yes"); await until(() => !f.app.ui.busy); await f.terminal.flush();
    assert.equal(f.app.ui.composer.editor.getText(), "/notifications yes"); assert.match(f.terminal.text(), /Use \/notifications/);
    await f.send("/help"); await until(() => f.terminal.text().includes("Toggle reply notifications"));
    assert.match(f.terminal.text(), /\/notifications \[on\|off\]/); f.terminal.send("\r"); await until(() => !f.app.ui.busy);
    assert.equal((await f.app.chat.conversation.context(f.context)).entries.length, 0); assert.equal(f.faux.state.callCount, 0);
    f.faux.appendResponses([f.host.fauxProvider.fauxAssistantMessage("Muted **reply**.")]);
    await f.send("Muted input."); await f.app.chat.conversation.waitForIdle(f.context); await f.terminal.flush();
    assert.equal(f.notifications.length, 0);
    await f.send("/notifications on"); await until(() => !f.app.ui.busy); await f.terminal.flush();
    assertBell(f, effectiveOn);
    for (const columns of [40, 80, 110, 160]) {
      f.terminal.resize(columns, 30); await f.terminal.flush(); assertBell(f, effectiveOn);
      assert(f.app.ui.tui.getScreenLines().every((line) => f.host.tui.visibleWidth(line) <= columns));
    }
    f.faux.appendResponses([f.host.fauxProvider.fauxAssistantMessage("Enabled **reply**.")]);
    await f.send("Enabled input."); await f.app.chat.conversation.waitForIdle(f.context);
    const expectedNotifications = effectiveOn ? 1 : 0;
    assert.equal(f.notifications.length, expectedNotifications);
    if (effectiveOn) assert.equal(f.notifications[0].body, "Enabled reply.");
    await f.send("/notifications off"); await until(() => !f.app.ui.busy);
    await f.send("/new"); await until(() => !f.app.ui.busy);
    assert.equal((await f.app.chat.harness.snapshot(f.Settings, f.context)).enabled, false);
    await f.send("/session-new"); await until(() => f.app.chat.file === f.second && !f.app.ui.busy); await f.terminal.flush();
    assert.equal(await f.app.chat.harness.snapshot(f.Settings, f.context), undefined); assertBell(f, effectiveOn);
    await f.app.close(); await f.mount(f.first); await f.terminal.flush(); assertBell(f, false);
    assert.equal((await f.app.chat.harness.snapshot(f.Settings, f.context)).enabled, false);
    assert.equal(f.notifications.length, expectedNotifications); assert.deepEqual(f.errors, []);
  } finally { await f.close(); f.host.tui.setCapabilities(capabilities); }
});

test("muting during a native generation is local and suppresses its eventual final reply notification", { ...hostTest, timeout: 15000 }, async () => {
  const f = await fixture(), entered = Promise.withResolvers(), release = Promise.withResolvers();
  try {
    f.faux.appendResponses([async () => { entered.resolve(); await release.promise; return f.host.fauxProvider.fauxAssistantMessage("Final muted reply."); }]);
    await f.mount(); await f.send("Wait for the fixture."); await entered.promise;
    let preflights = 0; f.app.chat.beforeModel = async () => { preflights++; throw new Error("No model preflight for local controls."); };
    await f.send("/notifications off");
    await until(() => f.app.ui.composer.editor.getText() === "" && f.terminal.text().includes("Notifications off"));
    assert.equal((await f.app.chat.harness.snapshot(f.Settings, f.context)).enabled, false);
    release.resolve(); await f.app.chat.conversation.waitForIdle(f.context); await f.terminal.flush();
    assert.equal(preflights, 0); assert.equal(f.notifications.length, 0); assert.equal(f.faux.state.callCount, 1);
    const users = (await f.app.chat.conversation.context(f.context)).messages.filter((message) => message.role === "user");
    assert.equal(users.length, 1); assert(!JSON.stringify(users).includes("/notifications")); assert.deepEqual(f.errors, []);
  } finally { release.resolve(); await f.close(); }
});

test("the production hook reads the exact session document written by its command before any delivery work", {
  ...hostTest, skip: hostTest.skip || (process.platform !== "darwin" || !environmentEnabled() ? "Production hook is disabled on this platform/process" : false),
}, async () => {
  const f = await fixture();
  try {
    const chat = await f.make(f.first), signal = new AbortController().signal;
    try {
      await f.extension.piD.commands[0].execute("off", { harness: chat.harness, conversation: chat.conversation, signal, context: f.context, toast() {} });
      const reads = [], memos = new Map();
      await f.extension.hooks[0].handlers.onYield({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Never deliver this fixture." }] }, {
        conversationId: f.host.sdk.ROOT_CONVERSATION_ID,
        memo: async (name, candidate) => { if (!memos.has(name)) memos.set(name, candidate); return memos.get(name); },
        snapshot: async (token, ...args) => {
          reads.push(token.definition.kind);
          // Also makes the test safe if gating regresses: do not let it reach focus queries or notification effects.
          if (token.definition.kind !== notificationSettings.kind) throw new Error("Unexpected delivery preparation.");
          return chat.harness.snapshot(token, ...args);
        },
      }, f.context);
      assert.deepEqual(reads, [notificationSettings.kind]); assert.equal(memos.size, 1);
    } finally { await chat.close(); }
  } finally { await f.close(); }
});
