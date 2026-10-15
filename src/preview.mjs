import { basename } from "node:path";
import { stripVTControlCharacters } from "node:util";

/** Remove terminal commands, control characters, and directional spoofing. */
export function plainText(text) {
  return stripVTControlCharacters(String(text))
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, " ")
    .replace(/\s+/gu, " ")
    .normalize("NFC")
    .trim();
}

export function truncate(text, limit) {
  const parts = Array.from(
    new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text),
    ({ segment }) => segment,
  );
  return parts.length <= limit ? text : `${parts.slice(0, limit - 1).join("").trimEnd()}…`;
}

/** Only public answer text: never thinking, tool arguments, or tool results. */
export function answerText(answer) {
  if (answer?.role !== "assistant" || !["stop", "length", "toolUse"].includes(answer.stopReason)) return null;
  if (!Array.isArray(answer.content) || answer.content.some((part) => part.type === "toolCall")) return null;
  const text = answer.content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
  return text.trim() ? text : null;
}

export function preview(text, limit = 160) {
  // Bound work on unusually large replies. Remove code blocks, not just fences.
  const prose = stripVTControlCharacters(text.slice(0, 64_000))
    .replace(/(?:^|\n)[\t ]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n[\t ]*\1[\t ]*(?=\n|$)|$)/g, "\n")
    .replace(/^[\t ]{0,3}\[[^\]]+\]:[^\n]*$/gm, "")
    .replace(/!?\[([^\]]*)\]\([^\n)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
    .replace(/^[\t ]*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/gm, "")
    .replace(/`+([^`]+)`+/g, "$1")
    .replace(/(\*\*|__|~~)([^\n]+?)\1/g, "$2")
    .replace(/(?<!\w)([*_])([^\n]+?)\1(?!\w)/g, "$2")
    .replace(/\\([\\`*_{}\[\]()#+\-.!>~])/g, "$1");
  return truncate(plainText(prose) || "Reply ready.", limit);
}

export function notificationTitle(workspace) {
  const project = typeof workspace === "string" ? plainText(basename(workspace)) : "";
  return project ? `pi-d · ${truncate(project, 60)}` : "pi-d";
}
