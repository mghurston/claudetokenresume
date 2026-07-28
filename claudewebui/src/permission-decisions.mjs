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
