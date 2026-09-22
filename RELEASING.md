# Releasing

1. Bump the version in sync: `package.json` (+ lockfile via
   `npm install --package-lock-only`), `VERSION` in `server.js`, and the
   `#v{version}` tag pin in `README.md`'s install snippet. The protocol test
   asserts server.js against package.json, so drift fails the suite.
2. Merge the server release PR.
3. Tag the resulting `main` commit, push the tag, and verify it is available on
   the remote: `git tag v{version}` then `git push origin v{version}`.
4. Update the `~/.codex/config.toml` entry if it pins a tag. The documented
   snippet does, so consumers must refresh it after each release.
5. In agent-plugins: bump the `claude-code` plugin's `.mcp.json` tag pin and
   `.codex-plugin/plugin.json` version, then merge that dependent change only
   after the server tag is available, or consumers receive an unresolved pin.

Merging and publishing require the user’s explicit authorization.
