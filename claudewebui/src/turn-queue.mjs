/**
 * Turns parked until the usage window resets.
 *
 * Deliberately in memory only. A queued turn holds the prompt text you wrote,
 * and Studio's whole privacy posture is that conversation content lives in the
 * real transcript and nowhere else — writing drafts to disk would put message
 * bodies in a second place with a different lifetime. The cost is that a server
 * restart drops the queue, which is the honest outcome anyway: the CLI process
 * behind each session went with it.
 *
 * One turn per session. Queueing again on the same session replaces the parked
 * turn rather than stacking, so the session cannot wake up and fire a backlog.
 */
export class TurnQueue {
  constructor() {
    this.entries = new Map();
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
    return this.publicEntry(stored);
  }

  cancel(sessionId) {
    const entry = this.entries.get(sessionId);
    if (!entry) {
      return null;
    }
    this.entries.delete(sessionId);
    return this.publicEntry(entry);
  }

  /**
   * Hands over every parked turn and empties the queue in one step, so a second
   * lift signal arriving mid-release cannot send anything twice.
   */
  drain() {
    const parked = [...this.entries.values()];
    this.entries.clear();
    return parked;
  }
}
