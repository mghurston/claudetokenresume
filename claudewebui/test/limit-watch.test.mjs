import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyProbe,
  classifyRateLimitEvent,
  LimitWatch,
  toEpochMs,
} from "../src/limit-watch.mjs";

function headers(entries) {
  return new Map(Object.entries(entries));
}

/**
 * A watch wired to fake time and a scripted sequence of readings, so the state
 * machine can be driven through a full cap cycle without a network or a wait.
 */
function testWatch(readings = []) {
  const released = [];
  const queue = [...readings];
  const watch = new LimitWatch({
    credentialsPath: "unused",
    now: () => 1_000_000,
    setTimer: () => null,
    clearTimer: () => {},
    onRelease: (snapshot) => released.push(snapshot),
  });
  watch.check = async () => {
    watch.apply(queue.shift(), "probe") && watch.release();
    return watch.snapshot();
  };
  return { watch, released };
}

test("a spent 5-hour window is a cap once nothing is covering it", () => {
  const reading = classifyProbe(
    headers({
      "anthropic-ratelimit-unified-5h-status": "rejected",
      "anthropic-ratelimit-unified-5h-reset": "1780000000",
      "anthropic-ratelimit-unified-5h-utilization": "1.0",
      "anthropic-ratelimit-unified-7d-utilization": "0.09",
    }),
    429,
  );
  assert.equal(reading.status, "capped");
  assert.equal(reading.resetAt, 1780000000000);
  assert.equal(reading.utilization, 100, "the API reports a fraction, not a percent");
  assert.equal(reading.weeklyUtilization, 9);
});

test("a spent window that overage is carrying is NOT a cap", () => {
  // Verified live: 5h-status rejected, utilization 1.0, yet HTTP 200 because
  // overage credits were paying for the request. Work is flowing, so nothing
  // should be queued or released against it.
  const reading = classifyProbe(
    headers({
      "anthropic-ratelimit-unified-5h-status": "rejected",
      "anthropic-ratelimit-unified-5h-reset": "1785226200",
      "anthropic-ratelimit-unified-5h-utilization": "1.0",
      "anthropic-ratelimit-unified-7d-status": "allowed",
      "anthropic-ratelimit-unified-overage-in-use": "true",
      "anthropic-ratelimit-unified-overage-status": "allowed",
    }),
    200,
  );
  assert.equal(reading.status, "lifted");
  assert.equal(reading.usingOverage, true);
});

test("overage that is itself rejected stops covering the window", () => {
  const reading = classifyProbe(
    headers({
      "anthropic-ratelimit-unified-5h-status": "rejected",
      "anthropic-ratelimit-unified-overage-in-use": "true",
      "anthropic-ratelimit-unified-overage-status": "rejected",
    }),
    200,
  );
  assert.equal(reading.status, "capped");
});

test("a refused request is a cap whatever the headers claim", () => {
  assert.equal(classifyProbe(headers({}), 429).status, "capped");
  assert.equal(
    classifyProbe(
      headers({
        "anthropic-ratelimit-unified-5h-status": "allowed",
        "anthropic-ratelimit-unified-overage-in-use": "true",
      }),
      429,
    ).status,
    "capped",
  );
});

test("falls back to the HTTP status when the headers are missing", () => {
  assert.equal(classifyProbe(headers({}), 200).status, "lifted");
  assert.equal(classifyProbe(headers({}), 401).status, "unknown");
  assert.equal(classifyProbe(headers({}), 500).status, "unknown");
});

test("waits on whichever window is holding work up", () => {
  const weekly = classifyProbe(
    headers({
      "anthropic-ratelimit-unified-5h-status": "allowed",
      "anthropic-ratelimit-unified-5h-reset": "1780000000",
      "anthropic-ratelimit-unified-7d-status": "rejected",
      "anthropic-ratelimit-unified-7d-reset": "1790000000",
    }),
    429,
  );
  assert.equal(weekly.status, "capped");
  assert.equal(weekly.resetAt, 1790000000000, "the weekly cap, not the 5-hour one");
});

test("normalizes seconds, milliseconds and ISO timestamps", () => {
  assert.equal(toEpochMs(1780000000), 1780000000000);
  assert.equal(toEpochMs("1780000000"), 1780000000000);
  assert.equal(toEpochMs(1780000000000), 1780000000000);
  assert.equal(toEpochMs("2026-07-27T12:40:00.000Z"), Date.parse("2026-07-27T12:40:00.000Z"));
  assert.equal(toEpochMs(null), null);
  assert.equal(toEpochMs("not a date"), null);
});

test("the SDK event maps onto the same shape as a probe", () => {
  assert.equal(classifyRateLimitEvent({ status: "rejected" }).status, "capped");
  assert.equal(classifyRateLimitEvent({ status: "allowed" }).status, "lifted");
  // A warning still means work is going through.
  assert.equal(classifyRateLimitEvent({ status: "allowed_warning" }).status, "lifted");
  assert.equal(classifyRateLimitEvent(null), null);

  const reading = classifyRateLimitEvent({
    status: "rejected",
    resetsAt: 1780000000,
    rateLimitType: "five_hour",
    utilization: 1,
  });
  assert.equal(reading.resetAt, 1780000000000);
  assert.equal(reading.limitType, "five_hour");
  assert.equal(reading.utilization, 100);
});

test("the SDK event honours overage the same way the headers do", () => {
  assert.equal(
    classifyRateLimitEvent({ status: "rejected", isUsingOverage: true }).status,
    "lifted",
  );
  assert.equal(
    classifyRateLimitEvent({
      status: "rejected",
      isUsingOverage: true,
      overageStatus: "rejected",
    }).status,
    "capped",
  );
});

test("arming while the limit is fine never fires the queued turn", async () => {
  // The worst possible bug for unattended work: releasing on "not capped right
  // now" would send every queued turn the instant it was armed.
  const { watch, released } = testWatch([
    { status: "lifted", detail: "" },
    { status: "lifted", detail: "" },
  ]);
  await watch.check();
  await watch.check();
  assert.deepEqual(released, []);
  assert.equal(watch.sawCap, false);
});

test("releases only after a real capped to lifted transition", async () => {
  const { watch, released } = testWatch([
    { status: "lifted", detail: "" },
    { status: "capped", resetAt: 1_500_000, detail: "" },
    { status: "capped", resetAt: 1_500_000, detail: "" },
    { status: "lifted", detail: "" },
  ]);
  await watch.check();
  await watch.check();
  assert.deepEqual(released, [], "still capped");
  await watch.check();
  assert.deepEqual(released, [], "repeat cap is not a transition");
  await watch.check();
  assert.equal(released.length, 1);
});

test("a second cap cycle needs its own cap before it can release again", async () => {
  const { watch, released } = testWatch([
    { status: "capped", detail: "" },
    { status: "lifted", detail: "" },
    { status: "lifted", detail: "" },
    { status: "capped", detail: "" },
    { status: "lifted", detail: "" },
  ]);
  for (let i = 0; i < 5; i += 1) {
    await watch.check();
  }
  assert.equal(released.length, 2, "one release per cap cycle, not per lifted reading");
});

test("an expired token keeps the reset time and does not release", async () => {
  const { watch, released } = testWatch([
    { status: "capped", resetAt: 1_500_000, detail: "" },
    { status: "unknown", detail: "cannot read credentials" },
  ]);
  await watch.check();
  await watch.check();
  assert.deepEqual(released, []);
  assert.equal(watch.resetAt, 1_500_000, "falls back to the reset we already learned");
  assert.equal(watch.sawCap, true, "the observed cap is not forgotten");
});

test("sleeps until just past the reset, but never longer than the ceiling", () => {
  const watch = new LimitWatch({ now: () => 1_000_000, setTimer: () => null });
  watch.apply({ status: "capped", resetAt: 1_120_000, detail: "" }, "probe");
  assert.equal(watch.nextDelayMs(), 150_000, "reset + 30s grace");

  watch.apply({ status: "capped", resetAt: 9_999_999_999, detail: "" }, "probe");
  assert.equal(watch.nextDelayMs(), 5 * 60 * 1000, "a far-off reset cannot park the watch");

  watch.apply({ status: "capped", resetAt: 900_000, detail: "" }, "probe");
  assert.equal(watch.nextDelayMs(), 30_000, "a reset already in the past still waits a beat");
});

test("polling runs only while something is queued", () => {
  const watch = new LimitWatch({ now: () => 0, setTimer: () => null, clearTimer: () => {} });
  assert.equal(watch.polling, false);
  watch.setPendingCount(2);
  assert.equal(watch.polling, true);
  watch.setPendingCount(0);
  assert.equal(watch.polling, false, "no background HTTP once the queue drains");
});
