import {
  AgentDoc,
  defineDoc,
  GenerationTask,
  hook,
  ROOT_CONVERSATION_ID,
} from "@earendil-works/pi-durable";
import { defineChatExtension } from "pi-d-chat/extensions";
import { createOnYield } from "./src/notification.mjs";
import { createControls, notificationSettings, sessionEnabled } from "./src/settings.mjs";

const NotificationSettings = defineDoc(notificationSettings);

export default defineChatExtension({
  name: "pi-d-notification",
  piD: createControls(NotificationSettings),
  hooks: [hook(GenerationTask, {
    onYield: createOnYield({
      rootConversationId: ROOT_CONVERSATION_ID,
      readEnabled: async (api, context) => sessionEnabled(await api.snapshot(NotificationSettings, context)),
      readWorkspace: async (api, context) =>
        (await api.snapshot(AgentDoc, api.conversationId, context))?.cwd,
    }),
  })],
});
