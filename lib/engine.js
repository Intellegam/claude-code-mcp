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

import { canonicalizeCwd } from "./cwd.js";

export const MODEL_FAMILIES = Object.freeze(["fable", "opus", "sonnet", "haiku"]);

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

function duration(ms) {
  return ms < 1000 ? `${ms}ms` : `${Math.round(ms / 1000)}s`;
}

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
  const liveTurns = new Set(); // Includes turns still awaiting a session ID.
  const sessions = new Map(); // sessionId -> SessionRecord (public-facing)

  // --- Turn records -------------------------------------------------------

  function createTurn({ toolName, cwd }) {
    const now = Date.now();
    let resolveReady;
    const turn = {
      toolName,
      status: "starting",
      createdAt: now,
      finishedAt: null,
      cwd,
      timeoutMs,
      sessionId: null,
      model: null,
      requestedModel: undefined,
      contextTokens: null,
      compactedThisTurn: false,
      output: "",
      lastMessage: "",
      error: null,
      cancelRequested: false,
      cancelReason: null,
      sawInit: false,
      runner: null,
      watchdog: null,
      cleanup: null,
      readyPromise: null,
      resolveReady: null,
    };
    turn.readyPromise = new Promise((resolve) => {
      resolveReady = resolve;
    });
    turn.resolveReady = () => resolveReady(turn);
    liveTurns.add(turn);
    return turn;
  }

  function settleTurn(turn, status, patch = {}) {
    if (isTerminal(turn.status)) return;
    Object.assign(turn, patch, {
      status,
      finishedAt: Date.now(),
      output: patch.output ?? (turn.lastMessage || turn.output || ""),
    });
    if (turn.cleanup) turn.cleanup();
    liveTurns.delete(turn);
    turn.resolveReady();
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
            message: `Claude timed out after ${duration(turn.timeoutMs)}`,
            source: "timeout",
          }
        : null,
    });
  }

  // --- Session records ----------------------------------------------------

  function getOrCreateSession(sessionId, writable = false) {
    let session = sessions.get(sessionId);
    if (!session) {
      session = {
        sessionId,
        cwd: null,
        // Remembered so follow-ups inherit the permission level the session was
        // created with, the way a codex thread inherits its sandbox.
        writable,
        requestedModel: undefined,
        latestTurn: null,
      };
      sessions.set(sessionId, session);
    }
    if (writable) session.writable = true;
    // `cwd` is deliberately *not* refreshed here: a reply that names the wrong
    // cwd must not overwrite the one the session actually resumes from. It is
    // updated in `handleInit`, once a resume has proven the cwd works.
    return session;
  }

  // Check and attach synchronously, before starting any runner callbacks.
  function assertSessionAvailable(sessionId) {
    const existing = sessions.get(sessionId)?.latestTurn;
    if (existing && !isTerminal(existing.status)) {
      throw new Error(
        `Session ${sessionId} already has an active turn (${existing.status})`,
      );
    }
  }

  // --- Snapshots ----------------------------------------------------------

  function snapshotTurn(turn) {
    return {
      sessionId: turn.sessionId,
      toolName: turn.toolName,
      model: turn.model,
      contextTokens: turn.contextTokens,
      compactedThisTurn: turn.compactedThisTurn,
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
    turn.status = "cancelling";

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
              message:
                turn.cancelReason === "timeout"
                  ? `Claude timed out after ${duration(turn.timeoutMs)} and did not respond to interrupt within ${duration(cancelWatchdogMs)}`
                  : `Claude did not respond to interrupt within ${duration(cancelWatchdogMs)}`,
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

  function startTurn(
    turn,
    { prompt, model, writable = false, resume = null, verifyResumeCwd = false },
  ) {
    turn.writable = writable;
    turn.requestedModel = model;
    let runner;
    try {
      runner = createRunner({
        cwd: turn.cwd,
        model,
        writable,
        resume,
        verifyResumeCwd,
      });
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
      Promise.resolve(runner.close()).catch(() => {});
      turn.cleanup = null;
    };

    try {
      runner.start(prompt, {
        onInit: (sessionId) => handleInit(turn, sessionId),
        // Fired for init's resolution and again per assistant message —
        // last-write-wins, so a mid-turn fallback reports truthfully. Guarded
        // like the other handlers: a settled turn's snapshot must not change.
        onModel: (model) => {
          if (!isTerminal(turn.status)) turn.model = model;
        },
        onText: (text) => {
          turn.lastMessage = text;
        },
        onUsage: (usage) => {
          if (!isTerminal(turn.status)) turn.contextTokens = usage.contextTokens;
        },
        onCompact: () => {
          if (!isTerminal(turn.status)) turn.compactedThisTurn = true;
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
    if (!sessionId) {
      failTurn(turn, new Error("Claude initialized without a sessionId"), "setup");
      return;
    }
    if (
      turn.toolName === "claude-reply" &&
      turn.sessionId &&
      sessionId !== turn.sessionId
    ) {
      failTurn(
        turn,
        new Error(
          `Claude resumed session ${turn.sessionId} as ${sessionId}; refusing to change the public sessionId`,
        ),
        "setup",
      );
      return;
    }

    if (!turn.sessionId) {
      try {
        assertSessionAvailable(sessionId);
      } catch (err) {
        failTurn(turn, err, "setup");
        return;
      }
      turn.sessionId = sessionId;
      getOrCreateSession(sessionId, turn.writable === true).latestTurn = turn;
    }
    turn.sawInit = true;

    // The cwd is only recorded once a turn has actually started in it — a
    // failed resume must not replace the cwd later replies depend on.
    const session = turn.sessionId ? sessions.get(turn.sessionId) : null;
    if (session) {
      session.cwd = turn.cwd;
      // Keep the requested alias separate from the observed serving model.
      // A failed initialization must not replace the last usable selection.
      session.requestedModel = turn.requestedModel;
    }

    if (turn.status === "starting") turn.status = "running";
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

  function validateModel(turn, model) {
    if (model === undefined || MODEL_FAMILIES.includes(model)) return true;
    failTurn(
      turn,
      new Error(`model must be one of: ${MODEL_FAMILIES.join(", ")}`),
      "setup",
    );
    return false;
  }

  // --- Submissions --------------------------------------------------------

  /**
   * Create and start a `claude` turn, and hand the record back on the same
   * tick.
   *
   * The MCP layer has to hold the turn *before* `system/init`: until then the
   * turn has no sessionId, so a client cancelling the request that started it
   * has nothing `cancel({ sessionId })` could find. With the record in hand the
   * request cancellation and initialization-timeout paths can stop it directly.
   */
  function beginStart(args = {}) {
    const cwd = canonicalizeCwd(args.cwd || process.cwd());
    const turn = createTurn({ toolName: "claude", cwd });

    const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
    if (!prompt) {
      failTurn(turn, new Error("claude requires a non-empty prompt"), "setup");
      return turn;
    }

    if (!validateModel(turn, args.model)) return turn;
    startTurn(turn, {
      prompt,
      model: args.model,
      writable: args.writable === true,
    });
    return turn;
  }

  /** The `claude-reply` half of `beginStart` — same reason, same shape. */
  function beginReply(args = {}) {
    const sessionId = typeof args.sessionId === "string" ? args.sessionId : "";
    const known = sessionId ? sessions.get(sessionId) : null;
    const cwd = canonicalizeCwd(args.cwd || known?.cwd || process.cwd());
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

    if (!validateModel(turn, args.model)) return turn;
    turn.sessionId = sessionId;
    if (known?.cwd && cwd !== known.cwd) {
      failTurn(
        turn,
        new Error(
          `Claude session ${sessionId} must be resumed from the same cwd the session was created in (expected: ${known.cwd}, got: ${cwd})`,
        ),
        "setup",
      );
      return turn;
    }
    // Check first: creating/attaching before this would leave a stale session
    // record behind, or hide the genuinely running turn.
    try {
      assertSessionAvailable(sessionId);
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
    getOrCreateSession(sessionId, writable).latestTurn = turn;

    // Every reply resumes from disk — there is no long-lived Claude process to
    // hold the conversation, so this works across server restarts as long as
    // the cwd matches.
    startTurn(turn, {
      prompt,
      model: args.model ?? known?.requestedModel,
      writable,
      resume: sessionId,
      verifyResumeCwd: !known?.cwd,
    });
    return turn;
  }

  // --- Public API ---------------------------------------------------------

  return {
    beginStart,
    beginReply,
    snapshotForSubmission: snapshotTurn,
    result({ sessionId } = {}) {
      const session = sessions.get(sessionId);
      if (!session?.latestTurn) throw new Error("Unknown sessionId");
      return snapshotTurn(session.latestTurn);
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

    failBeforeInitialization(turn, message, source = "init_timeout") {
      if (!turn || isTerminal(turn.status) || turn.sawInit) return false;
      failTurn(turn, new Error(message), source);
      return true;
    },

    cancel({ sessionId } = {}) {
      const session = sessions.get(sessionId);
      if (!session?.latestTurn) throw new Error("Unknown sessionId");
      requestTurnCancel(session.latestTurn, "user");
      return snapshotTurn(session.latestTurn);
    },

    /**
     * Tear down every live turn (server shutdown).
     *
     * Each turn is settled here rather than left to its runner's `onDone`, so
     * initialization requests finish even if the child takes longer to die.
     */
    async shutdown() {
      const closing = [];
      for (const turn of [...liveTurns]) {
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
    _liveTurns: liveTurns,
  };
}
