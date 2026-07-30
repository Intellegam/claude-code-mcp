/**
 * Turn & session engine.
 *
 * Ported from the sibling codex-mcp server, minus its app-server connection
 * layer: sessions are Claude Code sessions, and every turn is a fresh
 * `query()` (a new one for `claude`, a `resume:` one for `claude-reply`).
 *
 * Sessions are the only user-facing identifier. Turn records are internal; a
 * session exposes the state of its latest turn through `snapshot()`.
 *
 * Turn states: starting → running → succeeded | failed | cancelled | timed_out
 * ("cancelling" is a transient state between a cancel request and the terminal
 * state, and is visible in snapshots.)
 */

import crypto from "node:crypto";
import path from "node:path";

export const TERMINAL_STATES = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
]);

export function isTerminal(status) {
  return TERMINAL_STATES.has(status);
}

export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_CANCEL_WATCHDOG_MS = 30_000;

const MAX_STDERR_EXCERPT = 600;

function stderrExcerpt(stderr) {
  const text = String(stderr || "").trim();
  if (!text) return "";
  return text.length > MAX_STDERR_EXCERPT
    ? `...${text.slice(-MAX_STDERR_EXCERPT)}`
    : text;
}

export function createEngine({
  createRunner,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  cancelWatchdogMs = DEFAULT_CANCEL_WATCHDOG_MS,
} = {}) {
  const turns = new Map(); // turn.id -> TurnRecord (internal)
  const sessions = new Map(); // sessionId -> SessionRecord (public-facing)
  const activeTurnsBySession = new Map(); // sessionId -> turn.id

  // --- Turn records -------------------------------------------------------

  function createTurn({ toolName, cwd }) {
    const now = Date.now();
    let resolveDone;
    let resolveReady;
    const turn = {
      id: crypto.randomUUID(), // internal only
      toolName,
      status: "starting",
      createdAt: now,
      updatedAt: now,
      finishedAt: null,
      cwd,
      timeoutMs,
      sessionId: null,
      output: "",
      lastMessage: "",
      error: null,
      cancelRequested: false,
      cancelReason: null,
      sawInit: false,
      sawResult: false,
      runner: null,
      watchdog: null,
      cleanup: null,
      donePromise: null,
      resolveDone: null,
      readyPromise: null,
      resolveReady: null,
    };
    turn.donePromise = new Promise((resolve) => {
      resolveDone = resolve;
    });
    turn.readyPromise = new Promise((resolve) => {
      resolveReady = resolve;
    });
    turn.resolveDone = () => resolveDone(turn);
    turn.resolveReady = () => resolveReady(turn);
    turns.set(turn.id, turn);
    return turn;
  }

  function updateTurn(turn, patch) {
    Object.assign(turn, patch, { updatedAt: Date.now() });
    if (turn.sessionId) {
      const session = sessions.get(turn.sessionId);
      if (session) notifySessionWaiters(session);
    }
  }

  function settleTurn(turn, status, patch = {}) {
    if (isTerminal(turn.status)) return;
    const now = Date.now();
    Object.assign(turn, patch, {
      status,
      updatedAt: now,
      finishedAt: now,
      output: patch.output ?? (turn.lastMessage || turn.output || ""),
    });
    if (turn.cleanup) turn.cleanup();
    releaseSessionClaim(turn);

    if (turn.sessionId) {
      const session = sessions.get(turn.sessionId);
      if (session) {
        if (session.activeTurnId === turn.id) {
          session.activeTurnId = null;
          session.updatedAt = now;
        }
        notifySessionWaiters(session);
      }
    }

    turn.resolveReady();
    turn.resolveDone();
  }

  function failTurn(turn, err, source) {
    settleTurn(turn, "failed", {
      error: { message: err.message || String(err), source },
    });
  }

  // --- Session records ----------------------------------------------------

  function getOrCreateSession(sessionId, cwd, writable = false) {
    let session = sessions.get(sessionId);
    if (!session) {
      const now = Date.now();
      session = {
        sessionId,
        cwd: cwd || null,
        // Remembered so follow-ups inherit the permission level the session was
        // created with, the way a codex thread inherits its sandbox.
        writable,
        createdAt: now,
        updatedAt: now,
        latestTurnId: null,
        activeTurnId: null,
        waiters: new Set(),
      };
      sessions.set(sessionId, session);
    }
    if (cwd) session.cwd = cwd;
    if (writable) session.writable = true;
    return session;
  }

  function attachTurnToSession(session, turn) {
    session.latestTurnId = turn.id;
    session.activeTurnId = turn.id;
    session.updatedAt = Date.now();
    notifySessionWaiters(session);
  }

  function claimSession(sessionId, turn) {
    const existingId = activeTurnsBySession.get(sessionId);
    if (existingId && existingId !== turn.id) {
      const existing = turns.get(existingId);
      if (existing && !isTerminal(existing.status)) {
        throw new Error(
          `Session ${sessionId} already has an active turn (${existing.status})`,
        );
      }
    }
    activeTurnsBySession.set(sessionId, turn.id);
  }

  function releaseSessionClaim(turn) {
    if (
      turn.sessionId &&
      activeTurnsBySession.get(turn.sessionId) === turn.id
    ) {
      activeTurnsBySession.delete(turn.sessionId);
    }
  }

  function notifySessionWaiters(session) {
    // Copy and clear before calling — waiters may re-add themselves.
    const waiters = [...session.waiters];
    session.waiters.clear();
    for (const waiter of waiters) waiter();
  }

  function waitForSessionDone(session) {
    return new Promise((resolve) => {
      const check = () => {
        const turn = turns.get(session.latestTurnId);
        if (!turn || isTerminal(turn.status)) {
          resolve();
          return true;
        }
        return false;
      };
      if (check()) return;
      const waiter = () => {
        if (!check()) session.waiters.add(waiter);
      };
      session.waiters.add(waiter);
    });
  }

  // --- Snapshots ----------------------------------------------------------

  function snapshotTurn(turn) {
    return {
      sessionId: turn.sessionId,
      toolName: turn.toolName,
      status: turn.status,
      done: isTerminal(turn.status),
      createdAt: new Date(turn.createdAt).toISOString(),
      finishedAt: turn.finishedAt
        ? new Date(turn.finishedAt).toISOString()
        : null,
      elapsed: turn.finishedAt
        ? `${Math.round((turn.finishedAt - turn.createdAt) / 1000)}s`
        : `${Math.round((Date.now() - turn.createdAt) / 1000)}s (running)`,
      cancelRequested: turn.cancelRequested,
      output: turn.output || "",
      error: turn.error,
    };
  }

  function snapshotSession(session) {
    const turn = turns.get(session.latestTurnId);
    if (!turn) {
      return {
        sessionId: session.sessionId,
        status: "unknown",
        done: false,
        error: { message: "No turn found for session", source: "internal" },
      };
    }
    return snapshotTurn(turn);
  }

  /** Snapshot for a turn that never made it onto its session. */
  function snapshotForSubmission(turn) {
    const session = turn.sessionId ? sessions.get(turn.sessionId) : null;
    const attached = session && session.latestTurnId === turn.id;
    return attached ? snapshotSession(session) : snapshotTurn(turn);
  }

  // --- Cancel -------------------------------------------------------------

  function requestTurnCancel(turn, reason = "user") {
    if (isTerminal(turn.status)) return turn;

    if (!turn.cancelRequested) {
      turn.cancelRequested = true;
      turn.cancelReason = reason;
    }
    if (turn.status !== "cancelling") {
      updateTurn(turn, { status: "cancelling" });
    }

    // The runner buffers this until `system/init` if the turn is not up yet.
    turn.runner?.interrupt();

    if (!turn.watchdog) {
      turn.watchdog = setTimeout(() => {
        if (isTerminal(turn.status)) return;
        // Force path: close() reaps the child (interrupt() is preferred over
        // abort() because abort emits no result message).
        Promise.resolve(turn.runner?.close()).catch(() => {});
        settleTurn(
          turn,
          turn.cancelReason === "timeout" ? "timed_out" : "cancelled",
          {
            error: {
              message: `Claude did not respond to interrupt within ${Math.round(cancelWatchdogMs / 1000)}s`,
              source: turn.cancelReason === "timeout" ? "timeout" : "cancel",
            },
          },
        );
      }, cancelWatchdogMs);
      turn.watchdog.unref?.();
    }

    return turn;
  }

  // --- Turn execution -----------------------------------------------------

  function startTurn(turn, { prompt, writable = false, resume = null }) {
    turn.writable = writable;
    let runner;
    try {
      runner = createRunner({ cwd: turn.cwd, writable, resume });
    } catch (err) {
      failTurn(turn, err, "setup");
      return;
    }
    turn.runner = runner;

    const timer = setTimeout(
      () => requestTurnCancel(turn, "timeout"),
      turn.timeoutMs,
    );
    timer.unref?.();

    let cleaned = false;
    turn.cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearTimeout(timer);
      if (turn.watchdog) clearTimeout(turn.watchdog);
      releaseSessionClaim(turn);
      Promise.resolve(runner.close()).catch(() => {});
      turn.cleanup = null;
    };

    try {
      runner.start(prompt, {
        onInit: (sessionId) => handleInit(turn, sessionId),
        onText: (text) => {
          turn.lastMessage = text;
        },
        onResult: (result) => handleResult(turn, result),
        onDone: (error, stderr) => handleDone(turn, error, stderr),
      });
    } catch (err) {
      failTurn(turn, err, "setup");
    }
  }

  function handleInit(turn, sessionId) {
    if (isTerminal(turn.status)) return;
    turn.sawInit = true;

    if (!turn.sessionId && sessionId) {
      turn.sessionId = sessionId;
      try {
        claimSession(sessionId, turn);
      } catch (err) {
        failTurn(turn, err, "setup");
        return;
      }
      attachTurnToSession(
        getOrCreateSession(sessionId, turn.cwd, turn.writable === true),
        turn,
      );
    }

    if (turn.status === "starting") updateTurn(turn, { status: "running" });
    turn.resolveReady();
  }

  function handleResult(turn, result) {
    if (isTerminal(turn.status)) return;
    turn.sawResult = true;
    const output = result.text || turn.lastMessage || "";

    // Precedence: a successful result wins over a pending cancel — the turn
    // finished before the interrupt landed, and its answer is worth keeping.
    if (!result.isError) {
      settleTurn(turn, "succeeded", { output, error: null });
      return;
    }

    if (turn.cancelRequested) {
      const status = turn.cancelReason === "timeout" ? "timed_out" : "cancelled";
      settleTurn(turn, status, {
        output,
        error:
          status === "timed_out"
            ? {
                message: `Claude timed out after ${Math.round(turn.timeoutMs / 1000)}s`,
                source: "timeout",
              }
            : null,
      });
      return;
    }

    settleTurn(turn, "failed", {
      output,
      error: {
        message: describeFailure(turn, result, turn.runner?.getStderr()),
        source: "turn",
      },
    });
  }

  function handleDone(turn, error, stderr) {
    if (isTerminal(turn.status)) return;
    // The stream ended without a terminal result: the child exited or the
    // iterator threw before anything was reported.
    if (turn.cancelRequested) {
      const status = turn.cancelReason === "timeout" ? "timed_out" : "cancelled";
      settleTurn(turn, status, {
        error:
          status === "timed_out"
            ? {
                message: `Claude timed out after ${Math.round(turn.timeoutMs / 1000)}s`,
                source: "timeout",
              }
            : null,
      });
      return;
    }
    settleTurn(turn, "failed", {
      error: {
        message: describeFailure(
          turn,
          null,
          stderr ?? turn.runner?.getStderr(),
          error,
        ),
        source: "sdk",
      },
    });
  }

  function describeFailure(turn, result, stderr, error) {
    const parts = [];
    if (result) {
      parts.push(
        result.errors.length
          ? result.errors.join("; ")
          : `Claude ended with ${result.subtype ?? "an error"}${
              result.terminalReason ? ` (${result.terminalReason})` : ""
            }`,
      );
    } else if (error) {
      parts.push(error.message || String(error));
    } else {
      parts.push("Claude exited without producing a result");
    }

    if (turn.toolName === "claude-reply" && !turn.sawInit) {
      parts.push(
        `Could not resume session ${turn.sessionId}. Resuming requires the same cwd the session was created in (tried: ${turn.cwd}) — pass the original cwd.`,
      );
    }

    const excerpt = stderrExcerpt(stderr);
    if (excerpt) parts.push(`stderr: ${excerpt}`);

    return parts.join(" | ");
  }

  // --- Submissions --------------------------------------------------------

  async function submitStart(args = {}) {
    const cwd = path.resolve(args.cwd || process.cwd());
    const turn = createTurn({ toolName: "claude", cwd });

    const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
    if (!prompt) {
      failTurn(turn, new Error("claude requires a non-empty prompt"), "setup");
      return turn;
    }

    startTurn(turn, { prompt, writable: args.writable === true });
    // A new session has no id until `system/init`; wait for it so the caller
    // always gets a sessionId back (or a terminal snapshot).
    await turn.readyPromise;
    return turn;
  }

  async function submitReply(args = {}) {
    const sessionId = typeof args.sessionId === "string" ? args.sessionId : "";
    const known = sessionId ? sessions.get(sessionId) : null;
    const cwd = path.resolve(args.cwd || known?.cwd || process.cwd());
    const turn = createTurn({ toolName: "claude-reply", cwd });

    const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
    if (!sessionId) {
      failTurn(
        turn,
        new Error("claude-reply requires a sessionId"),
        "setup",
      );
      return turn;
    }
    if (!prompt) {
      failTurn(
        turn,
        new Error("claude-reply requires a non-empty prompt"),
        "setup",
      );
      return turn;
    }

    turn.sessionId = sessionId;
    // Claim first: creating/attaching before this would leave a stale session
    // record behind, or hide the genuinely running turn.
    try {
      claimSession(sessionId, turn);
    } catch (err) {
      failTurn(turn, err, "setup");
      return turn;
    }
    // Follow-ups inherit the permission level of the session. After a server
    // restart that memory is gone and the reply is read-only.
    const writable = args.writable === true || known?.writable === true;
    attachTurnToSession(getOrCreateSession(sessionId, cwd, writable), turn);

    // Every reply resumes from disk — there is no long-lived Claude process to
    // hold the conversation, so this works across server restarts as long as
    // the cwd matches.
    startTurn(turn, { prompt, writable, resume: sessionId });
    await turn.readyPromise;
    return turn;
  }

  async function runToCompletion(turn) {
    if (!isTerminal(turn.status)) await turn.donePromise;
    if (turn.status !== "succeeded") {
      throw new Error(turn.error?.message || `Claude ${turn.status}`);
    }
    return { sessionId: turn.sessionId, output: turn.output };
  }

  // --- Public API ---------------------------------------------------------

  return {
    submitStart,
    submitReply,
    snapshotForSubmission,

    async runStart(args) {
      return runToCompletion(await submitStart(args));
    },

    async runReply(args) {
      return runToCompletion(await submitReply(args));
    },

    async result({ sessionId, wait = false } = {}) {
      const session = sessions.get(sessionId);
      if (!session) throw new Error("Unknown sessionId");
      if (wait) await waitForSessionDone(session);
      return snapshotSession(session);
    },

    cancel({ sessionId } = {}) {
      const session = sessions.get(sessionId);
      if (!session) throw new Error("Unknown sessionId");
      if (session.activeTurnId) {
        const turn = turns.get(session.activeTurnId);
        if (turn && !isTerminal(turn.status)) requestTurnCancel(turn, "user");
      }
      return snapshotSession(session);
    },

    /** Best-effort teardown of every live turn (server shutdown). */
    shutdown() {
      for (const turn of turns.values()) {
        if (isTerminal(turn.status)) continue;
        Promise.resolve(turn.runner?.close()).catch(() => {});
      }
    },

    // Exposed for tests.
    _turns: turns,
    _sessions: sessions,
  };
}
