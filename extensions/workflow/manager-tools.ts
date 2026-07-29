import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { registerSplitTool } from "./tools/split.ts";
import { registerBeadsTools } from "./tools/beads.ts";
import { registerVerificationTools } from "./tools/verification.ts";

export function registerManagerTools(pi: ExtensionAPI, _ctx: ExtensionCommandContext): void {
  registerSplitTool(pi);
  registerBeadsTools(pi);
  registerVerificationTools(pi);
}
