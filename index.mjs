import {
  AgentDoc,
  defineExtension,
  GenerationTask,
  hook,
  ROOT_CONVERSATION_ID,
} from "@earendil-works/pi-durable";
import { createOnYield } from "./src/notification.mjs";

export default defineExtension({
  name: "pi-d-notification",
  hooks: [hook(GenerationTask, {
    onYield: createOnYield({
      rootConversationId: ROOT_CONVERSATION_ID,
      readWorkspace: async (api, context) =>
        (await api.snapshot(AgentDoc, api.conversationId, context))?.cwd,
    }),
  })],
});
