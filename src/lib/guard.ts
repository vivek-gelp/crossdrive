/**
 * Global response-size guard: every tool result whose text exceeds
 * MAX_RESULT_CHARS is replaced by a JSON object with `truncated: true`, the
 * first part of the original text and tool-specific advice on how to page.
 * Applied by wrapping `registerTool` (see withResultGuard), so it covers every
 * tool in tools.ts and tools-mail.ts without touching their handlers.
 */
import type { McpServer } from "@modelcontextprotocol/server";

export const MAX_RESULT_CHARS = 60_000;
/** Room left for the wrapper fields around the kept text. */
const WRAPPER_RESERVE = 1_500;

const PAGING_HINTS: Record<string, string> = {
  read: "Call read again with a smaller maxChars and page with offset (nextOffset).",
  mail_attachment: "Call again with a smaller maxChars and page with offset (nextOffset).",
  mail_read: "Use a smaller maxChars, or read single messages by messageId instead of the whole thread.",
  find: "Use a smaller limit and follow nextPageToken, or scope with account, path or folderId.",
  list: "Follow nextPageToken page by page.",
  shared: "Narrow with query or foldersOnly and follow nextPageToken.",
  mail_search: "Use a smaller limit and follow nextPageToken.",
  changes: "Use a smaller limit or a later since, or fewer accounts.",
  audit: "Use a smaller limit or a date.",
  duplicates: "Narrow with path or folderId (acrossAccounts: path/paths as label:/folder, or account+folderId), raise minSize, or with acrossAccounts use a smaller limit and follow page.cursor.",
  tree: "Use a smaller depth or a deeper starting path.",
  inbox: "Ask for one account at a time.",
  batch: "Send fewer operations per call.",
};

export function pagingHint(tool: string): string {
  return PAGING_HINTS[tool] ?? "Narrow the request (fewer items, a smaller range) and call again.";
}

type TextResult = { content: { type: string; text?: string }[]; isError?: boolean; [k: string]: unknown };

/** Pure: cap one tool result. Results within the limit are returned unchanged. */
export function guardResult<R extends TextResult>(tool: string, r: R, max = MAX_RESULT_CHARS): R {
  const first = r.content?.[0];
  const text = first?.text;
  if (typeof text !== "string" || text.length <= max) return r;
  const render = (keep: number) =>
    JSON.stringify(
      {
        truncated: true,
        tool,
        originalChars: text.length,
        returnedChars: keep,
        howToPage: pagingHint(tool),
        note: `The result exceeded ${max} characters and was cut; partial holds the first ${keep} characters of the original text (not parseable on its own).`,
        partial: text.slice(0, keep),
      },
      null,
      1,
    );
  let keep = Math.max(0, max - WRAPPER_RESERVE);
  let out = render(keep);
  // JSON escaping can grow the kept text; shrink until the wrapper fits.
  while (out.length > max && keep > 0) {
    keep = Math.max(0, Math.floor((keep * max) / out.length) - 100);
    out = render(keep);
  }
  return { ...r, content: [{ ...first, type: "text", text: out }, ...r.content.slice(1)] };
}

/** A view of `server` whose registerTool applies guardResult to every handler's result. */
export function withResultGuard(server: McpServer): McpServer {
  return new Proxy(server, {
    get(target, prop) {
      if (prop === "registerTool") {
        return (name: string, def: unknown, handler: (...args: unknown[]) => Promise<TextResult>) =>
          (target.registerTool as unknown as (n: string, d: unknown, h: (...args: unknown[]) => Promise<TextResult>) => unknown)(name, def, async (...args: unknown[]) =>
            guardResult(name, await handler(...args)),
          );
      }
      const v = Reflect.get(target, prop, target) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}
