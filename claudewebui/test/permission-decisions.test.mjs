import assert from "node:assert/strict";
import test from "node:test";
import {
  canApproveForSession,
  modeAutoApproves,
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

test("Autopilot answers every prompt already waiting", () => {
  // Switching to Autopilot has to clear the dialog that is already up. The SDK
  // asks once and never re-asks, so anything still waiting would otherwise hang
  // until the ten-minute timeout denied it — with nobody there to notice.
  for (const toolName of ["Bash", "Write", "WebFetch", "Task"]) {
    assert.equal(modeAutoApproves("bypassPermissions", toolName), true);
  }
});

test("Accept edits answers edit prompts only", () => {
  assert.equal(modeAutoApproves("acceptEdits", "Write"), true);
  assert.equal(modeAutoApproves("acceptEdits", "Edit"), true);
  assert.equal(modeAutoApproves("acceptEdits", "NotebookEdit"), true);
  assert.equal(modeAutoApproves("acceptEdits", "Bash"), false);
  assert.equal(modeAutoApproves("acceptEdits", "WebFetch"), false);
});

test("the asking modes leave waiting prompts alone", () => {
  for (const mode of ["default", "plan", "dontAsk"]) {
    assert.equal(modeAutoApproves(mode, "Write"), false);
    assert.equal(modeAutoApproves(mode, "Bash"), false);
  }
});
