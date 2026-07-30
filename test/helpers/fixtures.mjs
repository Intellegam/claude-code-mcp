/**
 * Fixtures for the integration tier: a throwaway HOME and a "poisoned" repo
 * whose every ambient-configuration surface tries to make itself heard.
 *
 * If isolation works, none of the poison loads: no sentinel file is written,
 * no MCP tool appears, and the only project instructions reaching the model are
 * the ones the wrapper injects itself.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const PROJECT_MARKER = "MARKER-PROJECT-XYZZY-42";
export const USER_MARKER = "MARKER-USER-PLUGH-99";

/** Node script that plays a trivial MCP server and records that it ran. */
function poisonMcpServerSource(sentinelDir) {
  return `#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';
fs.writeFileSync(${JSON.stringify(path.join(sentinelDir, "mcp-server-started"))}, 'started');
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === 'initialize')
    send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'poison', version: '0.0.1' } } });
  else if (m.method === 'tools/list')
    send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'poison_ping', description: 'poison fixture tool', inputSchema: { type: 'object', properties: {} } }] } });
  else if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, result: {} });
});
`;
}

function hookCommand(sentinelDir, name) {
  return `/bin/sh -c 'echo fired > ${path.join(sentinelDir, name)}'`;
}

/**
 * Create a sandbox: temp HOME (poisoned at the user level), temp repo
 * (poisoned at the project level), and a sentinel directory.
 */
export function createSandbox({ poison = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccmcp-sandbox-"));
  const home = path.join(root, "home");
  const repo = path.join(root, "repo");
  const sentinels = path.join(root, "sentinels");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(sentinels, { recursive: true });

  fs.writeFileSync(
    path.join(repo, "CLAUDE.md"),
    `# Fixture project\n\n${PROJECT_MARKER}: the project instructions were loaded.\n`,
  );
  fs.writeFileSync(path.join(repo, "sample.txt"), "the sample file contents\n");

  if (poison) {
    // --- project-level poison ---
    const mcpServer = path.join(repo, "poison-mcp.mjs");
    fs.writeFileSync(mcpServer, poisonMcpServerSource(sentinels));
    fs.writeFileSync(
      path.join(repo, ".mcp.json"),
      JSON.stringify(
        { mcpServers: { poison: { command: process.execPath, args: [mcpServer] } } },
        null,
        2,
      ),
    );
    fs.mkdirSync(path.join(repo, ".claude", "commands"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, ".claude", "settings.json"),
      JSON.stringify(
        {
          env: { POISON_PROJECT_SETTING: "loaded" },
          hooks: {
            SessionStart: [
              {
                hooks: [
                  { type: "command", command: hookCommand(sentinels, "project-hook") },
                ],
              },
            ],
            PreToolUse: [
              {
                matcher: "*",
                hooks: [
                  {
                    type: "command",
                    command: hookCommand(sentinels, "project-pretooluse-hook"),
                  },
                ],
              },
            ],
          },
        },
        null,
        2,
      ),
    );
    fs.writeFileSync(
      path.join(repo, ".claude", "commands", "poisoncmd.md"),
      "---\ndescription: poison project command\n---\nhello from the fixture\n",
    );

    // --- user-level poison ---
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".claude", "CLAUDE.md"),
      `${USER_MARKER}: the user memory was loaded.\n`,
    );
    fs.writeFileSync(
      path.join(home, ".claude", "settings.json"),
      JSON.stringify(
        {
          hooks: {
            SessionStart: [
              {
                hooks: [
                  { type: "command", command: hookCommand(sentinels, "user-hook") },
                ],
              },
            ],
          },
        },
        null,
        2,
      ),
    );
  }

  return {
    root,
    home,
    repo,
    sentinels,
    firedSentinels: () => fs.readdirSync(sentinels),
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
