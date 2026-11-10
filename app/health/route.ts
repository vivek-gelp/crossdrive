import { NextResponse } from "next/server";
import { googleClient, VERSION } from "@/lib/config";
import { configWarnings } from "@/lib/status";
import { getStore, gmailGranted, loadAccounts } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Public liveness/status. Counts and booleans only: no labels, e-mails or env values (those are on /connect for the owner). */
export async function GET() {
  const warnings = configWarnings();
  const store = getStore();

  let accounts = 0;
  let gmailAccounts = 0;
  try {
    const list = await loadAccounts();
    accounts = list.length;
    gmailAccounts = list.filter((a) => gmailGranted(a)).length;
  } catch {
    warnings.push("Could not load accounts.");
  }

  return NextResponse.json(
    {
      ok: warnings.length === 0,
      service: "crossdrive",
      version: VERSION,
      storage: store.kind,
      accounts,
      gmailAccounts,
      googleConfigured: !!googleClient(),
      warnings,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
