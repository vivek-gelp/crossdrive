import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { baseUrl, VERSION } from "@/lib/config";
import { buildInstructions } from "@/lib/instructions";
import { SCOPE_FULL, verifyBearer } from "@/lib/oauth";
import { loadAccounts } from "@/lib/store";
import { registerAllTools, registerReadTools } from "@/lib/tools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Fluid compute: long operations (folder copies, URL uploads) still return a resume cursor well before this.
export const maxDuration = 300;

const serverInfo = { name: "crossdrive", title: "Crossdrive", version: VERSION };

/**
 * Handlers keyed by (scope, instructions). The instructions are generated per
 * request from the connected accounts and the active config, so a change on
 * /connect shows up without a redeploy; handlers are reused while they match.
 */
const handlers = new Map<string, (req: Request) => Promise<Response>>();
const MAX_CACHED_HANDLERS = 16;

async function handlerFor(full: boolean): Promise<(req: Request) => Promise<Response>> {
  const accounts = await loadAccounts().catch(() => []);
  const instructions = buildInstructions(accounts, { full });
  const key = `${full ? "full" : "read"}\n${instructions}`;
  let h = handlers.get(key);
  if (!h) {
    if (handlers.size >= MAX_CACHED_HANDLERS) handlers.clear();
    h = createMcpHandler(full ? registerAllTools : registerReadTools, { serverInfo, instructions });
    handlers.set(key, h);
  }
  return h;
}

const handler = withMcpAuth(
  async (req) => (await handlerFor(req.auth?.scopes.includes(SCOPE_FULL) ?? false))(req),
  verifyBearer,
  {
    required: true,
    resourceMetadataPath: "/.well-known/oauth-protected-resource",
    resourceUrl: baseUrl(),
  },
);

export { handler as GET, handler as POST, handler as DELETE };
