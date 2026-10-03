import { z } from "zod";
import { GenerateAppBlueprintBody } from "./generated/api";

export const BuilderConversationBody = GenerateAppBlueprintBody.extend({
  prompt: z.string().trim().min(1).max(1600),
  readyToBuild: z.boolean().default(false),
  designBrief: z.string().max(6000).default(""),
});
export const BuilderConversationResponse = z.object({
  assistantMessage: z.string().trim().min(1).max(1600),
  designBrief: z.string().max(6000),
  readyToBuild: z.boolean(),
});
export const GenerateDiscussedBlueprintBody = GenerateAppBlueprintBody.extend({
  designBrief: z.string().max(6000).default(""),
});
