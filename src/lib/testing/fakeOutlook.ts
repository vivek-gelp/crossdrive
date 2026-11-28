/**
 * Fake of the Microsoft Graph mail surface used by outlook.ts: well-known
 * folders, message list/search/filter, get, attachments, MIME drafts,
 * send (the sent copy gets a new id in Sent Items), PATCH, move and master
 * categories. Bearer `ms-tok-<label>` selects the mailbox.
 */

export interface FakeOutlookMessage {
  id: string;
  conversationId: string;
  folder: string;
  subject: string;
  from?: { name?: string; address: string };
  to: string[];
  cc?: string[];
  bcc?: string[];
  isRead?: boolean;
  isDraft?: boolean;
  categories?: string[];
  flagged?: boolean;
  date: number;
  internetMessageId?: string;
  body?: string;
  attachments?: { id: string; name: string; contentType: string; content: string; item?: boolean }[];
  /** Raw MIME of drafts created through the API. */
  raw?: string;
}

export interface FakeOutlook {
  fetchImpl: typeof fetch;
  mailboxes: Map<string, Map<string, FakeOutlookMessage>>;
  /** Messages sent through `messages/{id}/send`, in order. */
  sent: { label: string; message: FakeOutlookMessage }[];
  log: { method: string; url: string; body?: string }[];
  categories: string[];
}

const WELL_KNOWN = ["inbox", "sentitems", "drafts", "junkemail", "deleteditems", "archive"];
let seq = 0;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const err = (status: number, code: string) => json({ error: { code, message: code } }, status);
const rcpt = (a: string) => {
  const m = /^(.*)<([^>]+)>$/.exec(a.trim());
  return { emailAddress: m ? { name: m[1]!.trim().replace(/^"|"$/g, ""), address: m[2]! } : { address: a.trim() } };
};

function view(m: FakeOutlookMessage, select: string | null) {
  const full = {
    id: m.id,
    conversationId: m.conversationId,
    subject: m.subject,
    from: m.from ? { emailAddress: m.from } : null,
    toRecipients: m.to.map(rcpt),
    ccRecipients: (m.cc ?? []).map(rcpt),
    bccRecipients: (m.bcc ?? []).map(rcpt),
    replyTo: [],
    receivedDateTime: new Date(m.date).toISOString(),
    sentDateTime: m.isDraft ? null : new Date(m.date).toISOString(),
    isRead: m.isRead ?? true,
    isDraft: m.isDraft ?? false,
    parentFolderId: `fld-${m.folder}`,
    categories: m.categories ?? [],
    flag: { flagStatus: m.flagged ? "flagged" : "notFlagged" },
    hasAttachments: (m.attachments ?? []).length > 0,
    bodyPreview: (m.body ?? "").slice(0, 40),
    internetMessageId: m.internetMessageId,
    internetMessageHeaders: [],
    body: { contentType: "text", content: m.body ?? "" },
  };
  if (!select) return full;
  const keep = new Set(select.split(","));
  return Object.fromEntries(Object.entries(full).filter(([k]) => keep.has(k)));
}

function matchesKql(m: FakeOutlookMessage, kql: string): boolean {
  return kql
    .replace(/^"|"$/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .every((t) => {
      const lower = t.toLowerCase();
      if (lower === "hasattachments:true") return (m.attachments ?? []).length > 0;
      const recv = /^received(>=|<)(\d{4}-\d{2}-\d{2})$/.exec(lower);
      if (recv) return recv[1] === ">=" ? m.date >= Date.parse(recv[2]!) : m.date < Date.parse(recv[2]!);
      const [k, v] = lower.includes(":") ? lower.split(":", 2) : ["", lower];
      const from = `${m.from?.name ?? ""} ${m.from?.address ?? ""}`.toLowerCase();
      if (k === "from") return from.includes(v!);
      if (k === "subject") return m.subject.toLowerCase().includes(v!);
      return `${m.subject} ${m.body ?? ""} ${from}`.toLowerCase().includes(v!);
    });
}

function parseMime(raw: string) {
  const [head] = raw.split(/\r\n\r\n/, 1);
  const headers = new Map<string, string>();
  for (const line of head!.replace(/\r\n[ \t]+/g, " ").split("\r\n")) {
    const i = line.indexOf(":");
    if (i > 0) headers.set(line.slice(0, i).toLowerCase(), line.slice(i + 1).trim());
  }
  const list = (h: string) => (headers.get(h) ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return { headers, to: list("to"), cc: list("cc"), bcc: list("bcc"), subject: headers.get("subject") ?? "" };
}

export function fakeOutlook(mailboxes: Record<string, FakeOutlookMessage[]>, categories: string[] = []): FakeOutlook {
  const boxes = new Map(Object.entries(mailboxes).map(([label, ms]) => [label, new Map(ms.map((m) => [m.id, { ...m }]))]));
  const sent: FakeOutlook["sent"] = [];
  const log: FakeOutlook["log"] = [];

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : undefined;
    log.push({ method, url: url.toString(), body });
    const auth = new Headers(init?.headers).get("Authorization") ?? "";
    const label = auth.replace(/^Bearer ms-tok-/, "");
    const box = boxes.get(label);
    if (!box) return err(401, "InvalidAuthenticationToken");
    const path = decodeURIComponent(url.pathname.replace(/^\/v1\.0\/me/, ""));
    const select = url.searchParams.get("$select");
    let m: RegExpExecArray | null;

    if ((m = /^\/mailFolders\/(\w+)$/.exec(path)) && method === "GET") {
      if (!WELL_KNOWN.includes(m[1]!)) return err(404, "ErrorItemNotFound");
      const inFolder = [...box.values()].filter((x) => x.folder === m![1]);
      return json({ id: `fld-${m[1]}`, totalItemCount: inFolder.length, unreadItemCount: inFolder.filter((x) => x.isRead === false).length });
    }
    if (path === "/mailFolders/sentitems/messages" && method === "GET") {
      const f = /internetMessageId eq '(.*)'$/.exec(url.searchParams.get("$filter") ?? "");
      return json({ value: [...box.values()].filter((x) => x.folder === "sentitems" && x.internetMessageId === f?.[1]?.replace(/''/g, "'")).map((x) => view(x, select)) });
    }
    if (path === "/outlook/masterCategories") return json({ value: categories.map((displayName) => ({ displayName })) });

    if (path === "/messages" && method === "GET") {
      let list = [...box.values()];
      const filter = url.searchParams.get("$filter");
      const conv = filter && /conversationId eq '(.*)'$/.exec(filter);
      if (conv) list = list.filter((x) => x.conversationId === conv[1]!.replace(/''/g, "'"));
      else if (filter === "isRead eq false") list = list.filter((x) => x.isRead === false);
      else if (filter === "isRead eq true") list = list.filter((x) => x.isRead !== false);
      const search = url.searchParams.get("$search");
      if (search) list = list.filter((x) => matchesKql(x, search));
      list.sort((a, b) => b.date - a.date);
      const top = Number(url.searchParams.get("$top") ?? 10);
      const skip = Number(url.searchParams.get("$skip") ?? 0);
      const page = list.slice(skip, skip + top);
      const next = skip + top < list.length ? new URL(url) : undefined;
      next?.searchParams.set("$skip", String(skip + top));
      return json({ value: page.map((x) => view(x, select)), ...(next ? { "@odata.nextLink": next.toString() } : {}) });
    }
    if (path === "/messages" && method === "POST") {
      const raw = Buffer.from(body ?? "", "base64").toString("utf8");
      const p = parseMime(raw);
      const replyTo = p.headers.get("in-reply-to");
      const orig = replyTo ? [...box.values()].find((x) => x.internetMessageId === replyTo) : undefined;
      const id = `od${++seq}`;
      const msg: FakeOutlookMessage = {
        id,
        conversationId: orig?.conversationId ?? `conv-${id}`,
        folder: "drafts",
        subject: p.subject,
        from: { address: `${label}@example.com` },
        to: p.to,
        cc: p.cc,
        bcc: p.bcc,
        isDraft: true,
        date: Date.now(),
        internetMessageId: `<${id}@fake.outlook>`,
        raw,
      };
      box.set(id, msg);
      return json(view(msg, null), 201);
    }

    if ((m = /^\/messages\/([^/]+)\/attachments\/([^/]+)$/.exec(path))) {
      const a = box.get(m[1]!)?.attachments?.find((x) => x.id === m![2]);
      if (!a) return err(404, "ErrorItemNotFound");
      return json(
        a.item
          ? { "@odata.type": "#microsoft.graph.itemAttachment", id: a.id, name: a.name, contentType: a.contentType, size: a.content.length }
          : { "@odata.type": "#microsoft.graph.fileAttachment", id: a.id, name: a.name, contentType: a.contentType, size: a.content.length, contentBytes: Buffer.from(a.content).toString("base64") },
      );
    }
    if ((m = /^\/messages\/([^/]+)\/attachments$/.exec(path))) {
      const msg = box.get(m[1]!);
      if (!msg) return err(404, "ErrorItemNotFound");
      return json({ value: (msg.attachments ?? []).map((a) => ({ id: a.id, name: a.name, contentType: a.contentType, size: a.content.length })) });
    }
    if ((m = /^\/messages\/([^/]+)\/send$/.exec(path)) && method === "POST") {
      const msg = box.get(m[1]!);
      if (!msg || !msg.isDraft) return err(404, "ErrorItemNotFound");
      box.delete(msg.id);
      const copy: FakeOutlookMessage = { ...msg, id: `os${++seq}`, folder: "sentitems", isDraft: false, isRead: true, date: Date.now() };
      box.set(copy.id, copy);
      sent.push({ label, message: copy });
      return new Response(null, { status: 202 });
    }
    if ((m = /^\/messages\/([^/]+)\/move$/.exec(path)) && method === "POST") {
      const msg = box.get(m[1]!);
      if (!msg) return err(404, "ErrorItemNotFound");
      msg.folder = (JSON.parse(body ?? "{}") as { destinationId: string }).destinationId;
      return json(view(msg, null), 201);
    }
    if ((m = /^\/messages\/([^/]+)$/.exec(path))) {
      const msg = box.get(m[1]!);
      if (!msg) return err(404, "ErrorItemNotFound");
      if (method === "PATCH") {
        const p = JSON.parse(body ?? "{}") as { isRead?: boolean; categories?: string[]; flag?: { flagStatus: string } };
        if (p.isRead !== undefined) msg.isRead = p.isRead;
        if (p.categories) msg.categories = p.categories;
        if (p.flag) msg.flagged = p.flag.flagStatus === "flagged";
        return json(view(msg, null));
      }
      if (method === "DELETE") throw new Error("outlook.ts must never DELETE a message");
      return json(view(msg, select));
    }
    return err(400, `unhandled ${method} ${path}`);
  }) as typeof fetch;

  return { fetchImpl, mailboxes: boxes, sent, log, categories };
}
