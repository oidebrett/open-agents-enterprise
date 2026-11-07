// OAE: how a Hermes Agent's OCE Configuration selects Hermes's model provider.
import assert from "node:assert/strict";
import test from "node:test";

import {
  HermesConfigurationError,
  hermesModelSettings,
} from "../../apps/controller/src/drivers/compute/kubernetes/hermes.ts";

const configuration = (model: string, providers: Record<string, unknown> = {}) =>
  ({ agents: { defaults: { model } }, models: { providers } }) as never;

test("Hermes maps OpenAI, Anthropic and NVIDIA to its own providers", () => {
  assert.deepEqual(
    hermesModelSettings(
      configuration("openai/gpt-5.1", { openai: { baseUrl: "https://api.openai.com/v1" } }),
    ),
    { provider: "openai-api", model: "gpt-5.1", keyEnvironment: "OPENAI_API_KEY" },
  );
  assert.deepEqual(hermesModelSettings(configuration("anthropic/claude-sonnet-5")), {
    provider: "anthropic",
    model: "claude-sonnet-5",
    keyEnvironment: "ANTHROPIC_API_KEY",
  });
  assert.deepEqual(
    hermesModelSettings(
      configuration("openai/nvidia/nemotron", {
        openai: { baseUrl: "https://integrate.api.nvidia.com/v1" },
      }),
    ),
    { provider: "nvidia", model: "nvidia/nemotron", keyEnvironment: "NVIDIA_API_KEY" },
  );
});

test("Hermes runs any other OpenAI-compatible endpoint as its custom provider", () => {
  assert.deepEqual(
    hermesModelSettings(
      configuration("openai/meta-llama/llama-4-maverick", {
        openai: { baseUrl: "https://openrouter.ai/api/v1/" },
      }),
    ),
    {
      provider: "custom",
      model: "meta-llama/llama-4-maverick",
      keyEnvironment: "OPENAI_API_KEY",
      baseUrl: "https://openrouter.ai/api/v1",
    },
  );
});

test("Hermes refuses endpoints the OpenAI provider would refuse", () => {
  for (const baseUrl of [
    "http://openrouter.ai/api/v1",
    "https://openrouter.ai/api",
    "https://u:p@example.com/v1",
  ]) {
    assert.throws(
      () => hermesModelSettings(configuration("openai/m", { openai: { baseUrl } })),
      HermesConfigurationError,
    );
  }
  assert.throws(
    () =>
      hermesModelSettings(
        configuration("custom/m", { custom: { baseUrl: "https://example.com/v1" } }),
      ),
    HermesConfigurationError,
  );
});
