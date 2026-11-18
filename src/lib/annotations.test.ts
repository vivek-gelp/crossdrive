import type { McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { completeHints } from "./guard";
import { registerAllTools, registerReadTools } from "./tools";

type Def = { annotations?: Record<string, unknown> };

function defsOf(register: (s: McpServer) => void) {
  const defs: Record<string, Def> = {};
  const server = { registerTool: (name: string, d: Def) => void (defs[name] = d) } as unknown as McpServer;
  register(server);
  return defs;
}

const HINTS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"];

describe("tool annotations", () => {
  it.each([
    ["full", (s: McpServer) => registerAllTools(s)],
    ["read-only", (s: McpServer) => registerReadTools(s, { full: false })],
  ])("every tool on the %s server states all four hints", (_, register) => {
    const defs = defsOf(register);
    expect(Object.keys(defs).length).toBeGreaterThan(10);
    for (const [name, d] of Object.entries(defs)) {
      for (const h of HINTS) expect(typeof d.annotations?.[h], `${name}.${h}`).toBe("boolean");
    }
  });

  it("keeps the hints each tool set and stays honest about trash and reads", () => {
    const defs = defsOf((s) => registerAllTools(s));
    expect(defs.trash?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(defs.untrash?.annotations).toMatchObject({ destructiveHint: false });
    expect(defs.batch?.annotations?.destructiveHint).toBe(true);
    expect(defs.find?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true });
    expect(defs.audit?.annotations?.openWorldHint).toBe(false);
  });

  it("defaults an unspecified write to destructive, as the MCP spec does", () => {
    expect(completeHints({})).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
  });
});
