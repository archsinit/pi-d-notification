import assert from "node:assert/strict";
import test from "node:test";
import { answerText, notificationTitle, plainText, preview, truncate } from "../src/preview.mjs";

const answer = (content, stopReason = "stop") => ({ role: "assistant", stopReason, content });

test("extracts only public text from final replies", () => {
  assert.equal(answerText(answer([
    { type: "thinking", thinking: "PRIVATE" },
    { type: "text", text: "Done." },
    { type: "text", text: "Tests passed." },
  ])), "Done.\nTests passed.");
  assert.equal(answerText(answer([{ type: "text", text: "Partial reply" }], "length")), "Partial reply");
  assert.equal(answerText(answer([{ type: "text", text: "Done" }], "toolUse")), "Done");
});

test("rejects tool rounds, errors, interruptions, and empty/thinking-only replies", () => {
  for (const stopReason of ["error", "aborted", "unknown"]) {
    assert.equal(answerText(answer([{ type: "text", text: "No alert" }], stopReason)), null);
  }
  assert.equal(answerText(answer([{ type: "toolCall", arguments: { secret: "PRIVATE" } }, { type: "text", text: "Running" }], "toolUse")), null);
  assert.equal(answerText(answer([{ type: "thinking", thinking: "PRIVATE" }])), null);
  assert.equal(answerText(answer([{ type: "text", text: "  " }])), null);
  assert.equal(answerText({ role: "user", content: "Hi" }), null);
  assert.equal(answerText(null), null);
});

test("formats concise Markdown prose without links, fences, or emphasis markers", () => {
  const text = "## Finished\n\n- **Fixed** `file_name.ts` and [added tests](https://example.com/private).\n- _Everything_ passed.\n\n```sh\nsecret_code --token PRIVATE\n```\n\n~~Old~~ behavior removed.";
  assert.equal(preview(text), "Finished Fixed file_name.ts and added tests. Everything passed. Old behavior removed.");
});

test("omits tilde fences, reference destinations, and unfinished code blocks", () => {
  assert.equal(preview("Ready.\n~~~js\nsecret()\n~~~\n[Docs][ref]\n[ref]: https://example.com/private"), "Ready. Docs");
  assert.equal(preview("Ready.\n```sh\nsecret()"), "Ready.");
  assert.equal(preview("```sh\necho test\n```"), "Reply ready.");
});

test("strips escape/control sequences and directional spoofing", () => {
  const input = "\x1b[31mDone\x1b[0m\x1b]777;notify;BAD;PRIVATE\x07\n\u202eHello\u0000world";
  assert.equal(plainText(input), "Done Hello world");
  assert.equal(preview(input), "Done Hello world");
});

test("truncates on grapheme boundaries, including emoji and combining characters", () => {
  const family = "👨‍👩‍👧‍👦";
  assert.equal(truncate(family.repeat(5), 4), family.repeat(3) + "…");
  assert.equal(preview("e\u0301".repeat(10), 5), "éééé…");
  assert.equal(preview("x".repeat(200)).length, 160);
  assert.equal(preview("Short."), "Short.");
});

test("uses only the workspace basename in the title", () => {
  assert.equal(notificationTitle("/Users/person/projects/my-project"), "pi-d · my-project");
  assert.equal(notificationTitle("/"), "pi-d");
  assert.equal(notificationTitle(undefined), "pi-d");
  assert.equal(notificationTitle("/tmp/\x1b[31mproject\x1b[0m"), "pi-d · project");
});
