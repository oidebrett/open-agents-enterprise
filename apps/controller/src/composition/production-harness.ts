import type { HarnessDescriptor, HarnessExecutionMode } from "@openclaw-enterprise/contracts";
import type { HarnessResolver } from "@openclaw-enterprise/occ";

export const DEVELOPMENT_HARNESS_DESCRIPTOR: HarnessDescriptor = Object.freeze({
  id: "openclaw",
  version: "1.0.0",
});

/** Dedicated Codex execution connects to the approved app-server protocol. */
export const PRODUCTION_HARNESS_DESCRIPTOR: HarnessDescriptor = Object.freeze({
  id: "codex",
  version: "1.0.0",
});

/** OAE: Hermes is the Agent's gateway and harness in one workload (Kubernetes Compute, hermes.ts). */
export const OAE_HERMES_HARNESS_DESCRIPTOR: HarnessDescriptor = Object.freeze({
  id: "hermes",
  version: "1.0.0",
});

/** OAE: Anthropic's `claude gateway` for people's Claude apps (Kubernetes Compute, claude-gateway.ts). */
export const OAE_CLAUDE_GATEWAY_HARNESS_DESCRIPTOR: HarnessDescriptor = Object.freeze({
  id: "claude-gateway",
  version: "1.0.0",
});

export function resolveApprovedHarness(
  harnessId: string,
  executionMode: HarnessExecutionMode,
): HarnessDescriptor | undefined {
  if (executionMode === "embedded" && harnessId === OAE_HERMES_HARNESS_DESCRIPTOR.id) {
    return OAE_HERMES_HARNESS_DESCRIPTOR;
  }
  if (executionMode === "embedded" && harnessId === OAE_CLAUDE_GATEWAY_HARNESS_DESCRIPTOR.id) {
    return OAE_CLAUDE_GATEWAY_HARNESS_DESCRIPTOR;
  }
  if (executionMode === "dedicated" && harnessId === PRODUCTION_HARNESS_DESCRIPTOR.id) {
    return PRODUCTION_HARNESS_DESCRIPTOR;
  }
  if (harnessId === DEVELOPMENT_HARNESS_DESCRIPTOR.id) {
    return DEVELOPMENT_HARNESS_DESCRIPTOR;
  }
  return undefined;
}

/** Production admits only approved, version-pinned Harness and placement combinations. */
export const resolveApprovedProductionHarness: HarnessResolver = (harnessId, executionMode) =>
  resolveApprovedHarness(harnessId, executionMode);
