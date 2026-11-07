import { msteams } from "./channels/msteams.mjs";
import { slack } from "./channels/slack.mjs";
import { renderChannelSection } from "./channels/shared-ui.mjs";

export function renderChannels(options: Parameters<typeof renderChannelSection>[0]) {
  // OAE: Microsoft Teams beside Slack (docs/oae/teams.md).
  return renderChannelSection(options, [slack, msteams]);
}
