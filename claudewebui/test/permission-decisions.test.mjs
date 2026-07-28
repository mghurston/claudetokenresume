import assert from "node:assert/strict";
import test from "node:test";
import {
  canApproveForSession,
  permissionResultFor,
  sessionPermissionUpdates,
} from "../src/permission-decisions.mjs";

test("rescopes SDK suggestions to the session", () => {
  const updates = sessionPermissionUpdates({
    toolName: "Bash",
    suggestions: [
      {
        type: "addRules",
        rules: [{ toolName: "Bash", ruleContent: "git status" }],
        behavior: "allow",
        destination: "projectSettings",
      },
    ],
  });

  assert.deepEqual(updates, [
    {
      type: "addRules",
      rules: [{ toolName: "Bash", ruleContent: "git status" }],
      behavior: "allow",
      destination: "session",
    },
  ]);
});

test("drops setMode suggestions so allow-for-session cannot widen the whole session", () => {
  const updates = sessionPermissionUpdates({
    toolName: "Edit",
    suggestions: [
      { type: "setMode", mode: "bypassPermissions", destination: "session" },
      {
        type: "addRules",
        rules: [{ toolName: "Edit" }],
        behavior: "allow",
        destination: "session",
      },
    ],
  });

  assert.equal(updates.length, 1);
  assert.equal(updates[0].type, "addRules");
});

test("falls back to a tool-wide session rule when the SDK offers no suggestions", () => {
  const updates = sessionPermissionUpdates({ toolName: "WebFetch", suggestions: [] });
  assert.deepEqual(updates, [
    {
      type: "addRules",
      rules: [{ toolName: "WebFetch" }],
      behavior: "allow",
      destination: "session",
    },
  ]);
});

test("cannot approve for session without a tool name", () => {
  assert.equal(canApproveForSession({ suggestions: [] }), false);
  assert.equal(sessionPermissionUpdates(null), null);
});

test("maps decisions onto SDK permission results", () => {
  const request = { toolName: "Read", suggestions: [] };

  assert.deepEqual(permissionResultFor("approve-once", request), { behavior: "allow" });

  const forSession = permissionResultFor("approve-for-session", request);
  assert.equal(forSession.behavior, "allow");
  assert.equal(forSession.updatedPermissions[0].destination, "session");

  assert.deepEqual(permissionResultFor("reject", request, "  use ripgrep instead  "), {
    behavior: "deny",
    message: "use ripgrep instead",
  });

  assert.equal(permissionResultFor("nonsense", request), null);
});

test("denying without feedback still gives Claude a reason", () => {
  const result = permissionResultFor("reject", { toolName: "Bash" }, "   ");
  assert.equal(result.behavior, "deny");
  assert.match(result.message, /denied/i);
});
