// A native session document: independent of conversation context/reset and other session files.
export const notificationSettings = {
  kind: "pi-d-notification.settings",
  version: 1,
  scope: "session",
  initial: () => ({ enabled: true }),
};

export const sessionEnabled = (settings) => settings?.enabled !== false;
export const environmentEnabled = (env = process.env) => !["0", "false"].includes(env.PI_D_NOTIFY);

// VS15 requests monochrome text presentation, so the host's colors can style the bells.
export const BELL = "\u{1f514}\ufe0e";
export const MUTED_BELL = "\u{1f515}\ufe0e";

/** Native document token supplied by the entry point; no SDK copy or module-level resources here. */
export function createControls(Settings, { env = process.env } = {}) {
  return {
    commands: [{
      name: "notifications",
      description: "Toggle reply notifications for this session",
      argumentHint: "[on|off]",
      complete: (prefix) => ["on", "off"].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
      async execute(argument, api) {
        api.signal.throwIfAborted();
        if (!["", "on", "off"].includes(argument)) throw new Error("Use /notifications to toggle, or /notifications on|off.");
        const enabled = await api.harness.commit(async (tx) => {
          const settings = await tx.doc(Settings);
          api.signal.throwIfAborted();
          settings.enabled = argument ? argument === "on" : !sessionEnabled(settings);
          return settings.enabled;
        }, api.context);
        api.signal.throwIfAborted();
        api.notify(`Notifications ${enabled ? "on" : "off"} for this session.${!environmentEnabled(env) ? " PI_D_NOTIFY disables alerts for this process." : ""}`);
      },
    }],
    async footer(api) {
      const settings = await api.harness.snapshot(Settings, api.context);
      const enabled = sessionEnabled(settings) && environmentEnabled(env);
      return [{ text: enabled ? BELL : MUTED_BELL, tone: enabled ? "gold" : "dim", strikethrough: !enabled }];
    },
  };
}
