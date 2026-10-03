import assert from "node:assert/strict";
import test from "node:test";
import {
  PROVIDER_CAPABILITIES,
  ROUTER_TASK_TYPES,
  inferModelCapabilities,
} from "./provider-adapter.mjs";

test("router exposes multimodal task capabilities", () => {
  for (const capability of [
    "transcription",
    "speech",
    "image_generation",
    "image_editing",
  ]) {
    assert.ok(ROUTER_TASK_TYPES.includes(capability));
    assert.ok(PROVIDER_CAPABILITIES.includes(capability));
  }
});

test("audio transcription is inferred from audio input", () => {
  assert.deepEqual(
    inferModelCapabilities({
      inputModalities: ["audio"],
      outputModalities: ["transcription"],
    }),
    ["transcription"],
  );
});

test("text to speech is inferred from text input and speech output", () => {
  assert.deepEqual(
    inferModelCapabilities({
      inputModalities: ["text"],
      outputModalities: ["speech"],
    }),
    ["speech"],
  );
});

test("image generation and image editing are inferred independently", () => {
  assert.deepEqual(
    inferModelCapabilities({
      inputModalities: ["text"],
      outputModalities: ["image"],
    }),
    ["image_generation"],
  );

  assert.deepEqual(
    inferModelCapabilities({
      inputModalities: ["text", "image"],
      outputModalities: ["image"],
    }),
    ["image_generation", "image_editing"],
  );
});

test("vision remains distinct from image editing", () => {
  assert.deepEqual(
    inferModelCapabilities({
      inputModalities: ["text", "image"],
      outputModalities: ["text"],
    }),
    ["chat", "vision"],
  );
});
