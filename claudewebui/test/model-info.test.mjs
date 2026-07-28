import assert from "node:assert/strict";
import test from "node:test";
import {
  effortLevels,
  isKnownEffort,
  isKnownModel,
  isKnownPermissionMode,
  modelCatalog,
  permissionModes,
} from "../src/model-info.mjs";

test("exposes model aliases the CLI understands", () => {
  const ids = modelCatalog().map((model) => model.id);
  assert.ok(ids.includes("opus"));
  assert.ok(ids.includes("sonnet"));
  assert.ok(ids.includes("haiku"));
  assert.equal(isKnownModel("opus"), true);
  assert.equal(isKnownModel("gpt-4"), false);
});

test("effort levels match the CLI's ladder", () => {
  assert.deepEqual(effortLevels(), ["low", "medium", "high", "xhigh", "max"]);
  assert.equal(isKnownEffort("xhigh"), true);
  assert.equal(isKnownEffort("turbo"), false);
});

test("permission modes cover ask through autopilot", () => {
  const ids = permissionModes().map((mode) => mode.id);
  assert.deepEqual(ids, ["default", "plan", "acceptEdits", "bypassPermissions"]);
  assert.equal(isKnownPermissionMode("plan"), true);
  assert.equal(isKnownPermissionMode("yolo"), false);
});

test("catalogs are copies, so a caller cannot mutate the shared list", () => {
  const first = modelCatalog();
  first.pop();
  assert.notEqual(modelCatalog().length, first.length);
});
