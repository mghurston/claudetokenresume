/**
 * Translates a Studio permission choice into a Claude Agent SDK
 * `PermissionResult`.
 *
 * The SDK hands us `suggestions` — the same rule updates the terminal UI would
 * apply behind "Yes, and don't ask again". We rescope those to `session` so a
 * choice made in Studio never edits the user's settings.json on disk.
 */
const SESSION_DESTINATION = "session";

export function sessionPermissionUpdates(request) {
  if (!request) {
    return null;
  }

  const suggestions = Array.isArray(request.suggestions) ? request.suggestions : [];
  const scoped = suggestions
    .filter((suggestion) => suggestion && typeof suggestion.type === "string")
    // A suggestion that flips the whole session into a looser permission mode
    // grants far more than "stop asking about this tool" — drop it.
    .filter((suggestion) => suggestion.type !== "setMode")
    .map((suggestion) => ({ ...suggestion, destination: SESSION_DESTINATION }));

  if (scoped.length) {
    return scoped;
  }

  if (typeof request.toolName === "string" && request.toolName) {
    return [
      {
        type: "addRules",
        rules: [{ toolName: request.toolName }],
        behavior: "allow",
        destination: SESSION_DESTINATION,
      },
    ];
  }

  return null;
}

export function canApproveForSession(request) {
  return sessionPermissionUpdates(request) !== null;
}

/** The tools `acceptEdits` waves through — the CLI's own edit set. */
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/**
 * Would `mode` have let `toolName` run without asking?
 *
 * Switching the dropdown to a looser mode has to settle the prompts that are
 * *already* open, not just the next ones. The SDK asks once per tool call and
 * never re-asks, so a dialog raised under Ask stays raised after the switch —
 * and since the whole point of picking Autopilot is that nobody is watching, it
 * would sit there until the ten-minute timeout denied it. That was the reported
 * "I put it on autopilot and it still asked me" bug.
 */
export function modeAutoApproves(mode, toolName) {
  if (mode === "bypassPermissions") {
    return true;
  }
  if (mode === "acceptEdits") {
    return EDIT_TOOLS.has(toolName);
  }
  return false;
}

export function permissionResultFor(decision, request, feedback) {
  if (decision === "reject") {
    return {
      behavior: "deny",
      message:
        String(feedback || "").trim() ||
        "The user denied this action in Claude CLI Studio.",
    };
  }

  if (decision === "approve-for-session") {
    const updatedPermissions = sessionPermissionUpdates(request);
    if (!updatedPermissions) {
      return null;
    }
    return { behavior: "allow", updatedPermissions };
  }

  if (decision === "approve-once") {
    return { behavior: "allow" };
  }

  return null;
}
