import { randomUUID } from "node:crypto";
import { answerText, notificationTitle, preview } from "./preview.mjs";
import { notifyUser } from "./terminals.mjs";
import { environmentEnabled } from "./settings.mjs";

const HANDLED_MEMO = "pi-d-notification.handled.v1";

function previewLength(env) {
  const value = Number(env.PI_D_NOTIFY_PREVIEW_LENGTH);
  return Number.isInteger(value) && value >= 16 && value <= 500 ? value : 160;
}

function reportError(error, env) {
  if (env.PI_D_NOTIFY_DEBUG !== "1") return;
  // execFile errors can include the entire command (and reply preview). Never log it.
  const code = String(error?.code ?? error?.name ?? "unknown").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 50);
  process.stderr.write(`[pi-d-notification] Notification skipped (${code}).\n`);
}

/** Invocation-scoped effects only; no timers, processes, or listeners at load time. */
export function createOnYield({
  rootConversationId,
  readEnabled = async () => true,
  readWorkspace = async () => process.cwd(),
  notify = notifyUser,
  env = process.env,
  platform = process.platform,
  onError = (error) => reportError(error, env),
}) {
  return async function onYield(answer, api, context) {
    const signal = context.abortSignal;
    if (platform !== "darwin" || !environmentEnabled(env) ||
        api.conversationId !== rootConversationId || signal?.aborted) return;
    try {
      const text = answerText(answer);
      if (text === null) return;
      // Record the attempt BEFORE any external effect, including a focused skip.
      // Recovery must not turn an old suppressed reply into a new alert. A unique
      // candidate also prevents two concurrent invocations from both winning.
      const candidate = randomUUID();
      if (await api.memo(HANDLED_MEMO, candidate, context) !== candidate || signal?.aborted) return;
      const shouldNotify = async () => {
        if (signal?.aborted || !environmentEnabled(env)) return false;
        return !!(await readEnabled(api, context)) && !signal?.aborted;
      };
      // Muted replies are claimed too: unmuting must not replay an old answer.
      if (!await shouldNotify()) return;
      const workspace = await readWorkspace(api, context);
      signal?.throwIfAborted();
      if (!await shouldNotify()) return;
      await notify({
        title: notificationTitle(workspace),
        body: preview(text, previewLength(env)),
      }, { env, platform, signal, shouldNotify });
    } catch (error) {
      // A notification, focus query, or permission failure must not fail generation.
      if (!signal?.aborted) {
        try { onError(error); } catch { /* Diagnostics are best-effort too. */ }
      }
    }
  };
}
