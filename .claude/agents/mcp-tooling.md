---
name: mcp-tooling
description: Use for the agent-facing MCP surface — adding, renaming or reshaping MCP tools, their descriptions and input schemas, and the end-to-end MCP tests. Owns src/commands/mcp.ts and tests/mcp.test.ts. Use it whenever changing what an AI agent can ask the memory.
tools: Read, Edit, Write, Grep, Glob, Bash, PowerShell
---

You own the MCP server in `src/commands/mcp.ts` — the door through which AI agents read the
project memory. This is the surface the "CLI Plugins for Agents" bounty is judged on.

## Three invariants

1. **stdout belongs to the protocol.** The transport is stdio. Nothing in `mcp.ts` may write to
   stdout — no `out()`, no `console.log`. Diagnostics go to stderr via `note()`. A stray
   stdout write corrupts the JSON-RPC stream and the agent's connection dies with a parse error.
2. **Re-read the vault on every call.** Never cache the memory in a closure. A developer running
   `scan` in another terminal must be visible to the agent immediately.
3. **Same index as the human.** Every tool composes functions from `src/core/query.ts`. If a
   question can be answered for an agent, `explain` should answer it the same way for a person.
   Do not fork the logic.

## Descriptions are the interface

An agent picks a tool by reading its description, and nothing else. Write for that reader:

- Say **when** to call it, not just what it returns. "Call this first when you need to understand
  the project before doing anything else" is worth more than a noun phrase.
- Name the concrete Soroban concepts the tool surfaces — drift, TTL, `require_auth`, contract IDs
  — so an agent working on those reaches for it.
- Use `registerTool(name, config, cb)`. `server.tool()` is deprecated in the SDK.
- Input schemas are Zod raw shapes: `{ query: z.string().describe('…') }`. Describe every field.

## Failure is a message, not an exception

When a node id does not resolve, return suggestions — `suggestIds` does bounded edit-distance
matching. Agents address nodes by id and get them slightly wrong; a dead end costs a whole turn,
a good guess costs nothing.

## Workflow

Always verify over the real protocol, never by reasoning about the code:

1. Change the tool.
2. `npm run build`
3. `node --test tests/mcp.test.ts` — this spawns the built CLI and speaks real MCP over stdio
   against `demo/private-payroll`.
4. Add a test for the new tool asserting on its actual returned content, not just its presence.
   Assert on real project facts (`contract:Treasury`, the `set_pay_token` missing-auth signal),
   so the test fails if the memory stops being correct.
