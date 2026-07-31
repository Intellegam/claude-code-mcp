/**
 * Fixtures for the integration tier.
 *
 * The wrapper runs a consultation as *the operator's own Claude Code*, so the
 * sandbox is a full configuration environment rather than a set of traps:
 *
 * - a throwaway `HOME` carrying user memory, a user `SessionStart` hook and a
 *   user-scope MCP server — all of which are expected to load;
 * - a repo carrying its CLAUDE.md, a project hook, a project `permissions.allow`
 *   that must not be able to widen the read-only surface, and `.mcp.json`
 *   servers — including a deliberately named agent-bridge server, the one thing
 *   the wrapper still has to deny.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startMock } from "./mock-api.mjs";
import { spawnServer } from "./harness.mjs";

export const PROJECT_MARKER = "MARKER-PROJECT-XYZZY-42";
export const USER_MARKER = "MARKER-USER-PLUGH-99";

/**
 * A scripted turn that takes ~15s: 500 lines, 30ms apart. Long enough that a
 * turn which settles in a couple of seconds can only have been stopped.
 */
export const LONG_STREAM = {
  text: Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join("\n"),
  slow: 30,
};

/** Benign MCP servers, one per scope: their tools are available by design. */
export const USER_MCP_TOOL = "mcp__usertool__user_ping";
export const REPO_MCP_TOOL = "mcp__repotool__repo_ping";
/** An agent-bridge server: denied in both modes, however it was declared. */
export const BRIDGE_MCP_TOOL = "mcp__codex-agent__codex";
/** A benign server the *operator's* project settings deny: their rule must win. */
export const DENIED_MCP_TOOL = "mcp__denytool__deny_ping";
export const MCP_TOOL_OUTPUT = "MCP-FIXTURE-TOOL-RAN";

/** Node script that plays a trivial MCP server exposing one tool. */
function mcpServerSource(serverName, toolName) {
  return `import readline from 'node:readline';
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === 'initialize')
    send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: ${JSON.stringify(serverName)}, version: '0.0.1' } } });
  else if (m.method === 'tools/list')
    send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: ${JSON.stringify(toolName)}, description: 'fixture tool', inputSchema: { type: 'object', properties: {} } }] } });
  else if (m.method === 'tools/call')
    send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: ${JSON.stringify(MCP_TOOL_OUTPUT)} }] } });
  else if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, result: {} });
});
`;
}

/** Write the fixture MCP servers and return an `mcpServers` config block. */
function declareMcpServers(dir, servers) {
  const mcpServers = {};
  for (const [serverName, toolName] of servers) {
    const file = path.join(dir, `${serverName}-mcp.mjs`);
    fs.writeFileSync(file, mcpServerSource(serverName, toolName));
    mcpServers[serverName] = { command: process.execPath, args: [file] };
  }
  return mcpServers;
}

function sessionStartHook(sentinelDir, name) {
  return {
    SessionStart: [
      {
        hooks: [
          {
            type: "command",
            command: `/bin/sh -c 'echo fired > ${path.join(sentinelDir, name)}'`,
          },
        ],
      },
    ],
  };
}

const writeJson = (file, value) =>
  fs.writeFileSync(file, JSON.stringify(value, null, 2));

/**
 * Create a sandbox: a temp HOME and a temp repo, both configured, plus a
 * sentinel directory the hooks write into.
 *
 * MCP servers are opt-in: they cost a subprocess per turn, and only the suites
 * that assert on them need the weight.
 */
export function createSandbox({ mcpServers = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccmcp-sandbox-"));
  const home = path.join(root, "home");
  const repo = path.join(root, "repo");
  const sentinels = path.join(root, "sentinels");
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(repo, ".claude"), { recursive: true });
  fs.mkdirSync(sentinels, { recursive: true });

  // --- user level ---
  fs.writeFileSync(
    path.join(home, ".claude", "CLAUDE.md"),
    `${USER_MARKER}: the user memory was loaded.\n`,
  );
  writeJson(path.join(home, ".claude", "settings.json"), {
    hooks: sessionStartHook(sentinels, "user-hook"),
  });

  // --- project level ---
  fs.writeFileSync(
    path.join(repo, "CLAUDE.md"),
    `# Fixture project\n\n${PROJECT_MARKER}: the project instructions were loaded.\n`,
  );
  fs.writeFileSync(path.join(repo, "sample.txt"), "the sample file contents\n");
  writeJson(path.join(repo, ".claude", "settings.json"), {
    // No settings source can widen the read-only surface: `disallowedTools`
    // beats on-disk allow rules. A *deny* rule points the other way — the
    // operator's own restriction, which the wrapper must not override.
    permissions: { allow: ["Bash", "Write"], deny: [DENIED_MCP_TOOL] },
    hooks: sessionStartHook(sentinels, "project-hook"),
  });

  if (mcpServers) {
    writeJson(path.join(home, ".claude.json"), {
      mcpServers: declareMcpServers(home, [["usertool", "user_ping"]]),
    });
    writeJson(path.join(repo, ".mcp.json"), {
      mcpServers: declareMcpServers(repo, [
        ["repotool", "repo_ping"],
        ["denytool", "deny_ping"],
        ["codex-agent", "codex"],
      ]),
    });
  }

  return {
    root,
    home,
    repo,
    firedSentinels: () => fs.readdirSync(sentinels).sort(),
    // A CLI child may still be flushing its transcript into HOME as we tear
    // down; retry, and never fail a suite over cleanup.
    cleanup: () => {
      try {
        fs.rmSync(root, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 100,
        });
      } catch {
        // leave it to the OS temp reaper
      }
    },
  };
}

/**
 * The whole integration-tier setup: sandbox + mock Anthropic API + a running
 * MCP server pointed at both. Returns everything a suite asserts on, plus the
 * teardown to call from `after`.
 *
 * `turns` may be a function of the sandbox, for scripts that need its paths
 * (a `Write` call, say, which the tool requires to be absolute).
 */
export async function startTier2({
  turns = [],
  mcpServers = false,
  env = {},
} = {}) {
  const sandbox = createSandbox({ mcpServers });
  let mock = null;
  let server = null;

  const spawn = () =>
    spawnServer({
      useMockQuery: false,
      cwd: sandbox.repo,
      env: {
        HOME: sandbox.home,
        CLAUDE_CODE_MCP_TEST_BASE_URL: mock.url,
        CLAUDE_TIMEOUT_MS: "120000",
        ...env,
      },
    });

  try {
    mock = await startMock({
      turns: typeof turns === "function" ? turns(sandbox) : turns,
    });
    server = spawn();
    await server.init();
  } catch (err) {
    // Half a setup still has to be taken down: the mock's listening socket
    // would otherwise hold the test worker open long after the suite failed.
    await server?.close().catch(() => {});
    await mock?.stop().catch(() => {});
    sandbox.cleanup();
    throw err;
  }

  const ctx = {
    sandbox,
    mock,
    server,
    /** Restart the MCP server, dropping its in-memory sessions. */
    async restart() {
      await ctx.server.close();
      ctx.server = spawn();
      await ctx.server.init();
    },
    async stop() {
      await ctx.server.close();
      await mock.stop();
      sandbox.cleanup();
    },
  };
  return ctx;
}
