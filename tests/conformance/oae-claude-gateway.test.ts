// OAE: the Claude Gateway runtime (docs/oae/claude-gateway.md).
import assert from "node:assert/strict";
import test from "node:test";

import {
  ClaudeGatewayConfigurationError,
  claudeGatewayConfigTemplate,
  claudeGatewayHost,
  claudeGatewayModels,
  claudeGatewayNames,
} from "../../apps/controller/src/drivers/compute/kubernetes/claude-gateway.ts";
import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";

const configuration = (model: string, models?: Record<string, unknown>) =>
  ({ agents: { defaults: { model, ...(models ? { models } : {}) } } }) as never;

test("the gateway offers the Anthropic models of the Agent's model list", () => {
  assert.deepEqual(
    claudeGatewayModels(
      configuration("anthropic/claude-sonnet-5-5", {
        "anthropic/claude-sonnet-5-5": {},
        "anthropic/claude-haiku-5-5": {},
        "openai/gpt-5.1": {},
      }),
    ),
    ["claude-haiku-5-5", "claude-sonnet-5-5"],
  );
  assert.deepEqual(claudeGatewayModels(configuration("anthropic/claude-haiku-5-5")), ["claude-haiku-5-5"]);
});

test("a gateway without an Anthropic model is refused", () => {
  assert.throws(() => claudeGatewayModels(configuration("openai/gpt-5.1")), ClaudeGatewayConfigurationError);
  assert.throws(
    () => claudeGatewayModels(configuration("anthropic/claude-x; rm -rf /")),
    ClaudeGatewayConfigurationError,
  );
});

test("each gateway has its own private name and object names", () => {
  const a = claudeGatewayHost("inst", { namespaceId: "ns", agentId: "a1" });
  const b = claudeGatewayHost("inst", { namespaceId: "ns", agentId: "a2" });
  assert.match(a, /^claude-[0-9a-f]{16}\.oae\.internal$/);
  assert.notEqual(a, b);
  assert.equal(a, claudeGatewayHost("inst", { namespaceId: "ns", agentId: "a1" }));
  assert.match(claudeGatewayNames("a1").base, /^claude-gw-[0-9a-f]{12}$/);
});

test("the config keeps secrets as environment references and sends Anthropic traffic to the masker", () => {
  const yaml = claudeGatewayConfigTemplate("claude-x.oae.internal", ["claude-haiku-5-5"]);
  assert.match(yaml, /public_url: https:\/\/claude-x\.oae\.internal:8443/);
  assert.match(yaml, /client_secret: \$\{OIDC_CLIENT_SECRET\}/);
  assert.match(yaml, /api_key: \$\{MASKER_KEY\}/);
  assert.match(yaml, /base_url: http:\/\/127\.0\.0\.1:8080/);
  assert.match(yaml, /availableModels: \[claude-haiku-5-5\]/);
  assert.match(yaml, /desktop: \{\}/);
  assert.doesNotMatch(yaml, /sk-ant/);
});

test("the claude-gateway Harness is approved Embedded only", () => {
  assert.equal(resolveApprovedHarness("claude-gateway", "embedded")?.id, "claude-gateway");
  assert.equal(resolveApprovedHarness("claude-gateway", "dedicated"), undefined);
});
