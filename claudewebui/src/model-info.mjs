/**
 * Claude Code resolves model aliases itself, so Studio ships a small catalog
 * rather than querying an endpoint. An empty selection means "whatever the CLI
 * is configured to use", which keeps `/model` and settings.json authoritative.
 */
const MODELS = [
  {
    id: "opus",
    name: "Opus (latest)",
    description: "Most capable — deep reasoning and long agentic runs",
  },
  {
    id: "sonnet",
    name: "Sonnet (latest)",
    description: "Balanced speed and capability for everyday work",
  },
  {
    id: "haiku",
    name: "Haiku (latest)",
    description: "Fastest and cheapest for simple, scoped tasks",
  },
  {
    id: "claude-opus-5",
    name: "Claude Opus 5",
    description: "Pinned Opus 5",
  },
  {
    id: "claude-sonnet-5",
    name: "Claude Sonnet 5",
    description: "Pinned Sonnet 5",
  },
  {
    id: "claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    description: "Pinned Haiku 4.5",
  },
];

const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];

const PERMISSION_MODES = [
  {
    id: "default",
    name: "Ask",
    description: "Prompt before edits, commands, and network access",
  },
  {
    id: "plan",
    name: "Plan",
    description: "Research and propose a plan without changing anything",
  },
  {
    id: "acceptEdits",
    name: "Accept edits",
    description: "Auto-approve file edits, still ask for commands",
  },
  {
    id: "bypassPermissions",
    name: "Autopilot",
    description: "Skip every permission prompt — use only in folders you trust",
  },
];

export function modelCatalog() {
  return MODELS.map((model) => ({ ...model }));
}

export function effortLevels() {
  return [...EFFORT_LEVELS];
}

export function permissionModes() {
  return PERMISSION_MODES.map((mode) => ({ ...mode }));
}

export function isKnownModel(modelId) {
  return MODELS.some((model) => model.id === modelId);
}

export function isKnownEffort(effort) {
  return EFFORT_LEVELS.includes(effort);
}

export function isKnownPermissionMode(mode) {
  return PERMISSION_MODES.some((entry) => entry.id === mode);
}
