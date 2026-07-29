import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Knows whether the account is inside its usage cap, and releases queued turns
 * the moment the window resets.
 *
 * Two sources, deliberately:
 *
 * 1. `rate_limit_event`, which the Agent SDK streams on any live query. Exact,
 *    free, and already flowing through the bridge — this is the primary source.
 * 2. A direct header probe, used only while turns are queued and nothing is
 *    running (runners self-dispose when idle, so source 1 goes quiet). It
 *    POSTs to /v1/messages with max_tokens 1 and reads the unified rate-limit
 *    response headers. While capped that call is rejected with HTTP 429 and
 *    costs nothing, but the reset header is still there, so we learn exactly
 *    when to resume.
 *
 * The OAuth token is READ ONLY. Claude Code rotates refresh tokens, so writing
 * back to .credentials.json could invalidate the user's login. If the token
 * expires mid-wait (401 -> unknown) we fall back to the reset time learned from
 * the last good check rather than trying to refresh it.
 */

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const PROBE_MODEL = "claude-haiku-4-5-20251001";
// Matches the desktop tool: resume a little after the window turns over rather
// than racing the reset and getting bounced straight back into the cap.
export const RESET_GRACE_MS = 30 * 1000;
const IDLE_POLL_MS = 5 * 60 * 1000;
const MAX_SLEEP_MS = 5 * 60 * 1000;
const MIN_POLL_MS = 30 * 1000;

export function defaultCredentialsPath() {
  return path.join(os.homedir(), ".claude", ".credentials.json");
}

export async function readOAuthToken(credentialsPath = defaultCredentialsPath()) {
  let raw;
  try {
    raw = await readFile(credentialsPath, "utf8");
  } catch {
    throw new Error("cannot read credentials");
  }
  let token;
  try {
    token = JSON.parse(raw)?.claudeAiOauth?.accessToken;
  } catch {
    throw new Error("cannot read credentials");
  }
  if (!token) {
    throw new Error("no OAuth token");
  }
  return token;
}

/**
 * Unix seconds, unix milliseconds, and ISO strings all show up across the
 * header and the SDK event, so normalize everything to epoch milliseconds.
 */
export function toEpochMs(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  if (typeof value === "string" && !/^\d+$/.test(value.trim())) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }
  // Anything below ~2001 in milliseconds is really seconds.
  return numeric < 1e12 ? Math.round(numeric * 1000) : Math.round(numeric);
}

function headerValue(headers, ...names) {
  for (const name of names) {
    const value = headers.get?.(name) ?? headers[name];
    if (value) {
      return String(value);
    }
  }
  return null;
}

/**
 * The API reports utilization as a fraction of the window (0.09 = 9%, 1.0 =
 * exhausted). Everything downstream wants a percentage.
 */
function toPercent(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  return numeric <= 1 ? Math.round(numeric * 1000) / 10 : Math.round(numeric * 10) / 10;
}

function isRejected(status) {
  return typeof status === "string" && status.toLowerCase() === "rejected";
}

/**
 * Decides whether work is actually being refused right now.
 *
 * "The 5-hour window is used up" and "you are blocked" are NOT the same thing.
 * Verified against a live account: `5h-status: rejected` with
 * `5h-utilization: 1.0` came back on an HTTP **200**, because
 * `overage-in-use: true` and `overage-status: allowed` — the window was spent
 * but overage credits were carrying the request. Treating that as a cap would
 * arm the watch against a limit the user never actually hit, and then fire the
 * queued turn at the next window rollover for no reason.
 *
 * So a cap means: the request was refused (429), or a window says rejected and
 * no overage is covering it.
 */
function isBlocked({ httpStatus, fiveHourStatus, weeklyStatus, overageStatus, overageInUse }) {
  if (httpStatus === 429) {
    return true;
  }
  const windowRejected = isRejected(fiveHourStatus) || isRejected(weeklyStatus);
  if (!windowRejected) {
    return false;
  }
  const overageCarrying = overageInUse === "true" && !isRejected(overageStatus);
  return !overageCarrying;
}

/**
 * Turns one probe response into a reading. Split out from the request so the
 * classification rules are testable without a network.
 *
 * Header names verified against a live subscription account 2026-07-27; if
 * Anthropic renames them, this is the one knob to tune.
 */
export function classifyProbe(headers, httpStatus) {
  const fiveHourStatus = headerValue(
    headers,
    "anthropic-ratelimit-unified-5h-status",
    "anthropic-ratelimit-unified-status",
  );
  const weeklyStatus = headerValue(headers, "anthropic-ratelimit-unified-7d-status");
  const overageStatus = headerValue(headers, "anthropic-ratelimit-unified-overage-status");
  const overageInUse = headerValue(headers, "anthropic-ratelimit-unified-overage-in-use");
  const fiveHourReset = headerValue(
    headers,
    "anthropic-ratelimit-unified-5h-reset",
    "anthropic-ratelimit-unified-reset",
  );
  const weeklyReset = headerValue(headers, "anthropic-ratelimit-unified-7d-reset");

  let status = "unknown";
  if (fiveHourStatus || weeklyStatus || httpStatus === 429 || httpStatus === 200) {
    status = isBlocked({
      httpStatus,
      fiveHourStatus,
      weeklyStatus,
      overageStatus,
      overageInUse,
    })
      ? "capped"
      : "lifted";
  }

  // Wait on whichever window is actually holding work up.
  const blockingReset = isRejected(fiveHourStatus)
    ? fiveHourReset
    : isRejected(weeklyStatus)
      ? weeklyReset
      : fiveHourReset;

  const fiveHourUtilization = toPercent(
    headerValue(
      headers,
      "anthropic-ratelimit-unified-5h-utilization",
      "anthropic-ratelimit-unified-utilization",
    ),
  );
  const weeklyUtilization = toPercent(
    headerValue(headers, "anthropic-ratelimit-unified-7d-utilization"),
  );

  return {
    status,
    resetAt: toEpochMs(blockingReset),
    utilization: fiveHourUtilization,
    weeklyUtilization,
    // Both windows, kept apart. The flat fields above answer "are we blocked and
    // until when"; these answer "how much of each window is left", which is what
    // the Usage panel shows and what the sidebar meter needs to draw anything at
    // all. Collapsing them to the blocking one left the meter blank whenever
    // nothing was blocking, which is nearly always.
    windows: {
      fiveHour: {
        status: fiveHourStatus || null,
        resetAt: toEpochMs(fiveHourReset),
        utilization: fiveHourUtilization,
      },
      weekly: {
        status: weeklyStatus || null,
        resetAt: toEpochMs(weeklyReset),
        utilization: weeklyUtilization,
      },
    },
    usingOverage: overageInUse === "true",
    limitType: headerValue(headers, "anthropic-ratelimit-unified-representative-claim"),
    detail:
      `http=${httpStatus} 5h=${fiveHourStatus ?? "-"} 7d=${weeklyStatus ?? "-"} ` +
      `overage=${overageInUse ?? "-"}/${overageStatus ?? "-"}`,
  };
}

/**
 * Normalizes the SDK's `rate_limit_event` into the same shape as a probe, so
 * both sources feed one state machine. The SDK exposes the same overage fields
 * the headers do, so the "spent window but overage is carrying it" case is
 * handled identically here.
 */
export function classifyRateLimitEvent(info) {
  if (!info || typeof info !== "object") {
    return null;
  }
  const rejected = info.status === "rejected";
  const overageCarrying =
    (info.isUsingOverage === true || info.overageInUse === true) &&
    info.overageStatus !== "rejected";

  let status = "unknown";
  if (info.status === "allowed" || info.status === "allowed_warning") {
    status = "lifted";
  } else if (rejected) {
    status = overageCarrying ? "lifted" : "capped";
  }

  // The event describes one window — whichever the CLI reports as
  // representative. Attribute it to that window only, so a 5-hour reading never
  // overwrites what we know about the weekly one, or vice versa.
  const resetAt = toEpochMs(info.resetsAt);
  const utilization = toPercent(info.utilization);
  const isWeekly = /7d|week/i.test(String(info.rateLimitType || ""));
  const window = { status: info.status || null, resetAt, utilization };

  return {
    status,
    resetAt,
    utilization: isWeekly ? null : utilization,
    weeklyUtilization: isWeekly ? utilization : null,
    windows: {
      fiveHour: isWeekly ? null : window,
      weekly: isWeekly ? window : null,
    },
    usingOverage: info.isUsingOverage === true || info.overageInUse === true,
    limitType: info.rateLimitType || null,
    detail: `sdk status=${info.status ?? "-"} type=${info.rateLimitType ?? "-"}`,
  };
}

export async function probeLimit({
  credentialsPath = defaultCredentialsPath(),
  fetchImpl = globalThis.fetch,
  signal,
} = {}) {
  let token;
  try {
    token = await readOAuthToken(credentialsPath);
  } catch (error) {
    return { status: "unknown", resetAt: null, detail: error.message };
  }

  let response;
  try {
    response = await fetchImpl(ANTHROPIC_MESSAGES_URL, {
      method: "POST",
      signal,
      headers: {
        "authorization": `Bearer ${token}`,
        "anthropic-version": "2023-06-01",
        // OAuth/subscription tokens need this or the call is rejected as an
        // API-key request and never reports the unified headers.
        "anthropic-beta": "oauth-2025-04-20",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: PROBE_MODEL,
        max_tokens: 1,
        messages: [{ role: "user", content: "." }],
      }),
    });
  } catch (error) {
    return { status: "unknown", resetAt: null, detail: error.message };
  }

  // 429 and 401 carry the headers too, so classify the response either way.
  return classifyProbe(response.headers, response.status);
}

/**
 * The cap state machine.
 *
 * The rule that matters most, carried over from the desktop tool: a queued turn
 * is released only after a real capped -> lifted transition. `sawCap` must
 * become true from an observed cap first. Arming while the limit is fine is
 * allowed and expected — the watch simply keeps waiting. Releasing on "not
 * capped right now" would fire every queued turn the instant it was armed,
 * which is the worst possible behavior for something that runs unattended.
 */
export class LimitWatch {
  constructor({
    credentialsPath = defaultCredentialsPath(),
    fetchImpl = globalThis.fetch,
    onChange = () => {},
    onRelease = () => {},
    now = () => Date.now(),
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (handle) => clearTimeout(handle),
  } = {}) {
    this.credentialsPath = credentialsPath;
    this.fetchImpl = fetchImpl;
    this.onChange = onChange;
    this.onRelease = onRelease;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;

    this.status = "unknown";
    this.resetAt = null;
    this.utilization = null;
    this.weeklyUtilization = null;
    // Per-window state, each updated only by a reading that actually mentions
    // it. The SDK event covers one window at a time, so merging rather than
    // replacing is what keeps both halves of the Usage panel populated.
    this.windows = { fiveHour: null, weekly: null };
    this.usingOverage = false;
    this.limitType = null;
    this.sawCap = false;
    this.lastCheckedAt = null;
    this.lastSource = null;
    this.detail = "";
    this.polling = false;
    this.timer = null;
    this.pendingCount = 0;
  }

  snapshot() {
    return {
      status: this.status,
      resetAt: this.resetAt,
      utilization: this.utilization,
      weeklyUtilization: this.weeklyUtilization,
      windows: {
        fiveHour: this.windows.fiveHour ? { ...this.windows.fiveHour } : null,
        weekly: this.windows.weekly ? { ...this.windows.weekly } : null,
      },
      usingOverage: this.usingOverage,
      limitType: this.limitType,
      sawCap: this.sawCap,
      polling: this.polling,
      lastCheckedAt: this.lastCheckedAt,
      lastSource: this.lastSource,
      detail: this.detail,
    };
  }

  /**
   * Folds one reading in from either source and reports whether this reading
   * completed a capped -> lifted transition.
   */
  apply(reading, source) {
    if (!reading) {
      return false;
    }
    const previousStatus = this.status;
    this.lastCheckedAt = this.now();
    this.lastSource = source;
    this.detail = reading.detail || "";

    if (reading.utilization !== null && reading.utilization !== undefined) {
      this.utilization = reading.utilization;
    }
    if (reading.weeklyUtilization !== null && reading.weeklyUtilization !== undefined) {
      this.weeklyUtilization = reading.weeklyUtilization;
    }
    for (const name of ["fiveHour", "weekly"]) {
      const window = reading.windows?.[name];
      if (window) {
        this.windows[name] = { ...window, observedAt: this.lastCheckedAt };
      }
    }
    if (reading.limitType) {
      this.limitType = reading.limitType;
    }
    if (typeof reading.usingOverage === "boolean") {
      this.usingOverage = reading.usingOverage;
    }

    // An expired token reports `unknown`. Keep the last known reset time and
    // keep waiting on the clock rather than throwing away what we learned.
    if (reading.status === "unknown") {
      this.status = "unknown";
      this.onChange(this.snapshot());
      return false;
    }

    this.status = reading.status;
    if (reading.resetAt) {
      this.resetAt = reading.resetAt;
    }

    if (reading.status === "capped") {
      this.sawCap = true;
      this.onChange(this.snapshot());
      return false;
    }

    const lifted = this.sawCap && previousStatus !== "lifted";
    if (reading.status === "lifted") {
      this.resetAt = null;
    }
    this.onChange(this.snapshot());
    return lifted;
  }

  /** Free signal from a live session — no network of our own. */
  observe(rateLimitInfo) {
    const released = this.apply(classifyRateLimitEvent(rateLimitInfo), "sdk");
    if (released) {
      this.release();
    }
  }

  async check() {
    const reading = await probeLimit({
      credentialsPath: this.credentialsPath,
      fetchImpl: this.fetchImpl,
    });
    const released = this.apply(reading, "probe");
    if (released) {
      this.release();
    }
    return this.snapshot();
  }

  release() {
    this.sawCap = false;
    this.onRelease(this.snapshot());
  }

  /**
   * How long to wait before the next probe. While capped with a known reset we
   * sleep to just past it; otherwise we tick slowly. Capped at MAX_SLEEP_MS so
   * a stale reset time can never park the watch for hours.
   */
  nextDelayMs() {
    if (this.status === "capped" && this.resetAt) {
      const untilReset = this.resetAt + RESET_GRACE_MS - this.now();
      return Math.min(MAX_SLEEP_MS, Math.max(MIN_POLL_MS, untilReset));
    }
    return IDLE_POLL_MS;
  }

  /** Polling runs only while something is queued; otherwise the SDK feed is enough. */
  setPendingCount(count) {
    this.pendingCount = count;
    if (count > 0) {
      this.startPolling();
    } else {
      this.stopPolling();
    }
  }

  startPolling() {
    if (this.polling) {
      return;
    }
    this.polling = true;
    this.onChange(this.snapshot());
    this.scheduleNext(0);
  }

  stopPolling() {
    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    if (this.polling) {
      this.polling = false;
      this.onChange(this.snapshot());
    }
  }

  scheduleNext(delayMs = this.nextDelayMs()) {
    if (this.timer) {
      this.clearTimer(this.timer);
    }
    this.timer = this.setTimer(async () => {
      this.timer = null;
      if (!this.polling) {
        return;
      }
      await this.check().catch(() => {});
      if (this.polling) {
        this.scheduleNext();
      }
    }, delayMs);
    this.timer?.unref?.();
  }

  dispose() {
    this.stopPolling();
  }
}
