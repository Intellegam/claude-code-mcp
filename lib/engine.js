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

const TERMINAL_STATES = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
]);

function isTerminal(status) {
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
      model: null,
      output: "",
      lastMessage: "",
      error: null,
      cancelRequested: false,
      cancelReason: null,
      sawInit: false,
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

  function setStatus(turn, status) {
    turn.status = status;
    turn.updatedAt = Date.now();
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

    const session = turn.sessionId ? sessions.get(turn.sessionId) : null;
    if (session && session.activeTurnId === turn.id) {
      session.activeTurnId = null;
      session.updatedAt = now;
    }
    // A turn that settled without becoming its session's latest one — an empty
    // prompt, a missing sessionId, a claim conflict, a runner that would not
    // start — is unreachable through the public API, and every caller holding
    // it (the submission snapshot, `runToCompletion`) holds the object itself.
    // Keeping the record would let a client grow the map without bound.
    if (!session || session.latestTurnId !== turn.id) turns.delete(turn.id);

    turn.resolveReady();
    turn.resolveDone();
  }

  function failTurn(turn, err, source) {
    settleTurn(turn, "failed", {
      error: { message: err.message || String(err), source },
    });
  }

  /**
   * Settle a turn whose cancel has landed. The reason decides the terminal
   * state, so a turn timeout that overtakes a user cancel still reads as
   * `timed_out` (see `requestTurnCancel`).
   */
  function settleCancel(turn, patch = {}) {
    const timedOut = turn.cancelReason === "timeout";
    settleTurn(turn, timedOut ? "timed_out" : "cancelled", {
      ...patch,
      error: timedOut
        ? {
            message: `Claude timed out after ${Math.round(turn.timeoutMs / 1000)}s`,
            source: "timeout",
          }
        : null,
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
      };
      sessions.set(sessionId, session);
    }
    if (writable) session.writable = true;
    // `cwd` is deliberately *not* refreshed here: a reply that names the wrong
    // cwd must not overwrite the one the session actually resumes from. It is
    // updated in `handleInit`, once a resume has proven the cwd works.
    return session;
  }

  function attachTurnToSession(session, turn) {
    const supersededId = session.latestTurnId;
    session.latestTurnId = turn.id;
    session.activeTurnId = turn.id;
    session.updatedAt = Date.now();
    // The superseded turn is unreachable through the public API (a session only
    // ever exposes its latest turn), so keeping it would just grow the map.
    if (supersededId && supersededId !== turn.id) {
      const superseded = turns.get(supersededId);
      if (superseded && isTerminal(superseded.status)) turns.delete(supersededId);
    }
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

  /**
   * Move a session record to the id `system/init` actually reported.
   *
   * Resume normally preserves the id, but the CLI is free to answer with a new
   * one; when it does, that id is the only handle that will resume again.
   */
  function rekeySession(previousId, sessionId, turn) {
    if (activeTurnsBySession.get(previousId) === turn.id) {
      activeTurnsBySession.delete(previousId);
    }
    const previous = sessions.get(previousId);
    if (previous && !sessions.has(sessionId)) {
      sessions.delete(previousId);
      previous.sessionId = sessionId;
      sessions.set(sessionId, previous);
      attachTurnToSession(previous, turn);
      return;
    }
    if (previous && previous.latestTurnId === turn.id) sessions.delete(previousId);
    attachTurnToSession(
      getOrCreateSession(sessionId, turn.cwd, turn.writable === true),
      turn,
    );
  }

  // --- Snapshots ----------------------------------------------------------

  function snapshotTurn(turn) {
    return {
      sessionId: turn.sessionId,
      toolName: turn.toolName,
      model: turn.model,
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
    return snapshotTurn(turns.get(session.latestTurnId));
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
    } else if (reason === "timeout" && turn.cancelReason !== "timeout") {
      // A turn the user already cancelled has now also blown its deadline. The
      // timeout is the harder bound, so it takes over the terminal state. The
      // watchdog armed by the earlier cancel is left alone on purpose: it
      // expires no later than one armed now, and the deadline must only tighten.
      turn.cancelReason = "timeout";
    }
    if (turn.status !== "cancelling") setStatus(turn, "cancelling");

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
        onInit: (sessionId, model) => handleInit(turn, sessionId, model),
        // An assistant message names the model that actually answered — on a
        // mid-turn fallback this overrides the one init resolved.
        onModel: (model) => {
          turn.model = model;
        },
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

  function handleInit(turn, sessionId, model) {
    if (isTerminal(turn.status)) return;
    turn.sawInit = true;
    turn.model = model ?? null;

    if (sessionId && sessionId !== turn.sessionId) {
      const previousId = turn.sessionId;
      // Claim before adopting the reported id: a failed claim settles the turn,
      // and settling has to happen under the id the caller used — under the
      // new one it would release the wrong claim and delete a turn the
      // original session still points at.
      try {
        claimSession(sessionId, turn);
      } catch (err) {
        failTurn(turn, err, "setup");
        return;
      }
      turn.sessionId = sessionId;
      if (previousId) {
        rekeySession(previousId, sessionId, turn);
      } else {
        attachTurnToSession(
          getOrCreateSession(sessionId, turn.cwd, turn.writable === true),
          turn,
        );
      }
    }

    // The cwd is only recorded once a turn has actually started in it — a
    // failed resume must not replace the cwd later replies depend on.
    const session = turn.sessionId ? sessions.get(turn.sessionId) : null;
    if (session) session.cwd = turn.cwd;

    if (turn.status === "starting") setStatus(turn, "running");
    turn.resolveReady();
  }

  function handleResult(turn, result) {
    if (isTerminal(turn.status)) return;
    const output = result.text || turn.lastMessage || "";

    // Precedence: a successful result wins over a pending cancel — the turn
    // finished before the interrupt landed, and its answer is worth keeping.
    if (!result.isError) {
      settleTurn(turn, "succeeded", { output, error: null });
      return;
    }

    if (turn.cancelRequested) {
      settleCancel(turn, { output });
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
      settleCancel(turn);
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

  /**
   * Create and start a `claude` turn, and hand the record back on the same
   * tick.
   *
   * The counterpart to `submitStart` for the MCP layer, which has to hold the
   * turn *before* `system/init`: until then the turn has no sessionId, so a
   * client cancelling the request that started it has nothing `cancel({
   * sessionId })` could find, and a child that stalls on startup would run to
   * its full turn timeout. With the record in hand the cancel goes through
   * `cancelTurn` instead.
   */
  function beginStart(args = {}) {
    const cwd = path.resolve(args.cwd || process.cwd());
    const turn = createTurn({ toolName: "claude", cwd });

    const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
    if (!prompt) {
      failTurn(turn, new Error("claude requires a non-empty prompt"), "setup");
      return turn;
    }

    startTurn(turn, { prompt, writable: args.writable === true });
    return turn;
  }

  /**
   * `beginStart`, plus the wait for the turn to come up.
   *
   * A new session has no id until `system/init`; waiting for it is what lets
   * the async-submission path answer with a sessionId (or a terminal snapshot).
   */
  async function submitStart(args = {}) {
    const turn = beginStart(args);
    await turn.readyPromise;
    return turn;
  }

  /** The `claude-reply` half of `beginStart` — same reason, same shape. */
  function beginReply(args = {}) {
    const sessionId = typeof args.sessionId === "string" ? args.sessionId : "";
    const known = sessionId ? sessions.get(sessionId) : null;
    const cwd = path.resolve(args.cwd || known?.cwd || process.cwd());
    const turn = createTurn({ toolName: "claude-reply", cwd });

    const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
    if (!sessionId) {
      failTurn(turn, new Error("claude-reply requires a sessionId"), "setup");
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
    // A reply inherits the permission level recorded for the session and
    // cannot ask for more: `claude-reply` takes no `writable` argument. After a
    // server restart that memory is gone and the reply is read-only.
    const writable = known?.writable === true;
    // A session first seen here is created with no cwd: the caller-supplied one
    // is unproven until a resume actually starts in it, and `handleInit` fills
    // it in then. Same rule as the one `getOrCreateSession` applies to a session
    // that is already known.
    attachTurnToSession(getOrCreateSession(sessionId, null, writable), turn);

    // Every reply resumes from disk — there is no long-lived Claude process to
    // hold the conversation, so this works across server restarts as long as
    // the cwd matches.
    startTurn(turn, { prompt, writable, resume: sessionId });
    return turn;
  }

  /** `beginReply`, plus the wait for the turn to come up. */
  async function submitReply(args = {}) {
    const turn = beginReply(args);
    await turn.readyPromise;
    return turn;
  }

  async function runToCompletion(turn) {
    if (!isTerminal(turn.status)) await turn.donePromise;
    if (turn.status !== "succeeded") {
      const reason = turn.error?.message || `Claude ${turn.status}`;
      // Keep the handle: a failed turn is often worth continuing rather than
      // restarting, and the sessionId is otherwise lost with the error.
      throw new Error(
        turn.sessionId
          ? `${reason} (sessionId: ${turn.sessionId} — use claude-reply/claude-result to continue)`
          : reason,
      );
    }
    return { sessionId: turn.sessionId, model: turn.model, output: turn.output };
  }

  // --- Public API ---------------------------------------------------------

  return {
    beginStart,
    beginReply,
    submitStart,
    submitReply,
    snapshotForSubmission,
    /**
     * Await a submitted turn's outcome. Split out of `runStart`/`runReply` so a
     * caller can hold the turn record while it waits — the MCP layer needs it to
     * cancel the turn when the client cancels the request that started it.
     */
    awaitTurn: runToCompletion,

    async runStart(args) {
      return runToCompletion(await submitStart(args));
    },

    async runReply(args) {
      return runToCompletion(await submitReply(args));
    },

    async result({ sessionId, wait = false } = {}) {
      const session = sessions.get(sessionId);
      if (!session) throw new Error("Unknown sessionId");
      // Capture the turn observed *now*: a reply arriving while we wait would
      // otherwise make us report the new turn's `done: false` for a question
      // about a turn that has already finished.
      const turn = turns.get(session.latestTurnId);
      if (wait && !isTerminal(turn.status)) await turn.donePromise;
      return snapshotTurn(turn);
    },

    /**
     * Cancel a turn the caller already holds.
     *
     * The pre-init counterpart of `cancel({ sessionId })`: a turn that has not
     * seen `system/init` has no session to look up, and the runner buffers the
     * interrupt until it does (the watchdog bounds the wait).
     */
    cancelTurn(turn) {
      if (!turn) return null;
      return requestTurnCancel(turn, "user");
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

    /**
     * Tear down every live turn (server shutdown).
     *
     * Each turn is settled here rather than left to its runner's `onDone`: a
     * caller blocked on a sync call gets an answer as soon as the decision is
     * made, however long the child then takes to actually die.
     */
    async shutdown() {
      const closing = [];
      for (const turn of turns.values()) {
        if (isTerminal(turn.status)) continue;
        closing.push(Promise.resolve(turn.runner?.close()));
        settleTurn(turn, "failed", {
          error: {
            message: "The MCP server shut down before the turn finished",
            source: "shutdown",
          },
        });
      }
      await Promise.allSettled(closing);
    },

    // Exposed for tests.
    _turns: turns,
  };
}
