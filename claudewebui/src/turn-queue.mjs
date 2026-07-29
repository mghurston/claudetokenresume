/**
 * Turns parked until the usage window resets.
 *
 * These used to be in memory only, to keep prompt text out of any file but the
 * real transcript. That reasoning stopped holding once Studio grew a Quit
 * button and a Restart button: a turn can sit here for hours waiting on a
 * 5-hour window, and losing it to a click — or to a machine that reboots
 * overnight — is a worse outcome than the file. So the queue is persisted, but
 * narrowly: its own file, 0600, deleted the moment the queue empties, holding
 * nothing but what is needed to send the turn. It is not a second transcript.
 *
 * One turn per session. Queueing again on the same session replaces the parked
 * turn rather than stacking, so the session cannot wake up and fire a backlog.
 */
export class TurnQueue {
  /**
   * `persist` receives the full entry list after every change, or null when the
   * queue empties. Injected so the queue stays synchronous and testable, and so
   * a failure to write can never take down the send path.
   */
  constructor({ persist = () => {} } = {}) {
    this.entries = new Map();
    this.persistFn = persist;
  }

  save() {
    try {
      this.persistFn(this.entries.size ? [...this.entries.values()] : null);
    } catch {
      /* a queue that cannot be written is still a working queue */
    }
  }

  /**
   * Reloads parked turns from a previous run.
   *
   * Entries whose uploads did not survive are kept: the prompt text is the part
   * worth rescuing, and `deliverTurn` already tolerates missing attachments by
   * failing that one turn loudly rather than silently sending an empty one.
   */
  restore(entries) {
    if (!Array.isArray(entries)) {
      return 0;
    }
    for (const entry of entries) {
      if (entry && typeof entry.sessionId === "string") {
        this.entries.set(entry.sessionId, { ...entry, uploadIds: [...(entry.uploadIds || [])] });
      }
    }
    return this.entries.size;
  }

  size() {
    return this.entries.size;
  }

  get(sessionId) {
    return this.entries.get(sessionId) || null;
  }

  has(sessionId) {
    return this.entries.has(sessionId);
  }

  /** Public shape for the sidebar and the composer banner — no attachment bytes. */
  publicEntry(entry) {
    return {
      sessionId: entry.sessionId,
      projectId: entry.projectId,
      isNewSession: entry.isNewSession,
      prompt: entry.prompt,
      attachmentCount: entry.uploadIds.length,
      model: entry.model,
      effort: entry.effort,
      permissionMode: entry.permissionMode,
      queuedAt: entry.queuedAt,
    };
  }

  list() {
    return [...this.entries.values()].map((entry) => this.publicEntry(entry));
  }

  add(entry) {
    const stored = {
      ...entry,
      uploadIds: [...(entry.uploadIds || [])],
      queuedAt: new Date().toISOString(),
    };
    this.entries.set(stored.sessionId, stored);
    this.save();
    return this.publicEntry(stored);
  }

  cancel(sessionId) {
    const entry = this.entries.get(sessionId);
    if (!entry) {
      return null;
    }
    this.entries.delete(sessionId);
    this.save();
    return this.publicEntry(entry);
  }

  /**
   * Hands over every parked turn and empties the queue in one step, so a second
   * lift signal arriving mid-release cannot send anything twice.
   */
  drain() {
    const parked = [...this.entries.values()];
    this.entries.clear();
    this.save();
    return parked;
  }
}
