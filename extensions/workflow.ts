/** Compatibility entrypoint for the modular workflow extension. */
export { default } from "./workflow/index.ts";
export {
  ensureRequirementDirs, extractSubtasksJson, preservedBaseline,
  renderedToolName, splitDecision,
} from "./workflow/runtime.ts";
export { registerManagerTools } from "./workflow/manager-tools.ts";
