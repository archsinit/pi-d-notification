import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const host = process.env.PI_D_HOST_PATH;

test("loads and registers through the existing pi-d host loader without modifying the host", {
  skip: host ? false : "Set PI_D_HOST_PATH to an existing pi-d checkout for the SDK smoke test",
}, async () => {
  const directory = resolve(host);
  const require = createRequire(join(directory, "package.json"));
  const { createJiti } = require("jiti");
  const loader = createJiti(import.meta.url, {
    fsCache: false,
    interopDefault: false,
    nativeModules: ["@earendil-works/pi-durable", "@earendil-works/pi-ai", "@earendil-works/pi-tui", "@earendil-works/chord", "typebox"],
  });
  const { codingRegistry } = await loader.import(join(directory, "src/coding.ts"));
  const entry = fileURLToPath(new URL("../index.mjs", import.meta.url));
  const registry = await codingRegistry({}, [entry]);
  const extension = registry.snapshot().extension("pi-d-notification");
  const sdk = await import(pathToFileURL(require.resolve("@earendil-works/pi-durable")).href);
  assert.equal(extension.name, "pi-d-notification");
  assert.equal(extension.hooks.length, 1);
  assert.equal(extension.hooks[0].task, sdk.GenerationTask.definition.name);
  assert.equal(typeof extension.hooks[0].handlers.onYield, "function");
  assert.equal(extension.tools, undefined);
  assert.equal(extension.tasks, undefined);
  // Empty replies have no external effects, even through the real SDK registration.
  await extension.hooks[0].handlers.onYield(
    { role: "assistant", stopReason: "stop", content: [] },
    { conversationId: sdk.ROOT_CONVERSATION_ID },
    { abortSignal: undefined },
  );
});
