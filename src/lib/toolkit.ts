/** Helpers shared by tools.ts and tools-mail.ts: result wrapping and the account-label schema. */
import type { ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";
import { LABEL_RE } from "./config";

export type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

export function text(data: unknown): ToolResult {
  return { content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] };
}

export function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Run a handler; any thrown error becomes an isError text result instead of a protocol error. */
export function wrap<A>(fn: (args: A, ctx: ServerContext) => Promise<unknown>) {
  return async (args: A, ctx: ServerContext): Promise<ToolResult> => {
    try {
      const out = await fn(args, ctx);
      return text(out);
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  };
}

/** An account label as chosen on /connect. Unknown labels fail later with the list of connected labels (store.getAccount). */
export const label = z
  .string()
  .regex(LABEL_RE, "label must be lower-case letters, digits or hyphens, starting with a letter (max 24); see the accounts tool")
  .describe("Account label (see the accounts tool for the connected labels)");
