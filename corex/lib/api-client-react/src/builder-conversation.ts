import { customFetch } from "./custom-fetch";
import type { AppBuilderInput, AppBuilderResult } from "./generated/api.schemas";

export type BuilderConversation = {
  assistantMessage: string;
  designBrief: string;
  readyToBuild: boolean;
};
type Input = Omit<AppBuilderInput, "prompt"> & { prompt: string; designBrief: string; readyToBuild?: boolean };

export function converseAboutApp(input: Input) {
  return customFetch<BuilderConversation>("/api/builder/converse", { method: "POST", body: JSON.stringify(input), responseType: "json" });
}
export function generateDiscussedBlueprint(input: Input) {
  return customFetch<AppBuilderResult>("/api/builder/generate", { method: "POST", body: JSON.stringify(input), responseType: "json" });
}
