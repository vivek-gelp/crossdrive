/**
 * In-memory fake of the Microsoft Graph OneDrive surface the adapter uses,
 * plus the identity-platform token endpoint. Multi-account: the bearer token
 * `ms-tok-<label>` selects the drive; the refresh token `rt-<label>` mints it.
 * Enforces the documented rules the adapter must follow: upload fragments
 * are multiples of 320 KiB (except the last), arrive in order with a fixed
 * total, carry NO Authorization header; conflictBehavior=fail gives 409.
 */
import { QuickXorHash } from "../hash";

export interface FakeMsItem {
  id: string;
  name: string;
  parentId?: string;
  folder?: boolean;
  content?: Uint8Array;
  modified: string;
  /** Recycle bin (DELETE) */
  deleted?: boolean;
}

export interface FakeMsOpts {
  /** Children page size (default 200). */
  pageSize?: number;
  /** Answer the next N Graph requests with 429 + Retry-After: 1. */
  throttle?: number;
  /** Store uploaded bytes with the last byte flipped (verification mismatch). */
  corruptUploads?: boolean;
  /** Rotate refresh tokens on refresh (`rt-<label>-2`). */
  rotate?: boolean;
}

export interface FakeMsAccount {
  items: Map<string, FakeMsItem>;
  rootId: string;
}

export interface FakeOneDrive {
  fetchImpl: typeof fetch;
  accounts: Map<string, FakeMsAccount>;
  /** Every request as "METHOD url" (auth header noted). */
  log: { method: string; url: string; auth: boolean; contentRange?: string; size?: number }[];
  opts: FakeMsOpts;
  /** Add a file or folder by path (`/A/b.txt`); parents are created. */
  put(label: string, path: string, content?: string | Uint8Array): FakeMsItem;
  get(label: string, path: string): FakeMsItem | undefined;
  pathOf(label: string, id: string): string;
}

let seq = 0;
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
const err = (status: number, code: string, message = code) => json({ error: { code, message } }, status);

export function fakeOneDrive(labels: string[], opts: FakeMsOpts = {}): FakeOneDrive {
  const accounts = new Map<string, FakeMsAccount>();
  for (const l of labels) {
    const rootId = `root-${l}`;
    accounts.set(l, { rootId, items: new Map([[rootId, { id: rootId, name: "root", folder: true, modified: "2026-01-01T00:00:00Z" }]]) });
  }
  const log: FakeOneDrive["log"] = [];
  const sessions = new Map<string, { label: string; parentId: string; name: string; total: number; received: Uint8Array[]; got: number }>();

  const children = (a: FakeMsAccount, id: string) => [...a.items.values()].filter((i) => i.parentId === id && !i.deleted).sort((x, y) => x.name.localeCompare(y.name));
  const childByName = (a: FakeMsAccount, id: string, name: string) => children(a, id).find((i) => i.name.toLowerCase() === name.toLowerCase());
  const pathOfItem = (a: FakeMsAccount, it: FakeMsItem): string => {
    if (it.id === a.rootId) return "/";
    const parent = a.items.get(it.parentId!)!;
    const pp = pathOfItem(a, parent);
    return pp === "/" ? `/${it.name}` : `${pp}/${it.name}`;
  };
  const byPath = (a: FakeMsAccount, path: string) => {
    let cur = a.items.get(a.rootId)!;
    for (const seg of path.split("/").filter(Boolean)) {
      const next = childByName(a, cur.id, decodeURIComponent(seg));
      if (!next) return undefined;
      cur = next;
    }
    return cur;
  };
  const view = (a: FakeMsAccount, it: FakeMsItem) => {
    const base: Record<string, unknown> = { id: it.id, name: it.name, lastModifiedDateTime: it.modified };
    if (it.id === a.rootId) return { ...base, root: {}, folder: { childCount: children(a, it.id).length } };
    const parent = a.items.get(it.parentId!)!;
    const pp = pathOfItem(a, parent);
    base.parentReference = { id: parent.id, path: `/drive/root:${pp === "/" ? "" : pp.split("/").map(encodeURIComponent).join("/")}` };
    if (it.folder) return { ...base, folder: { childCount: children(a, it.id).length } };
    const c = it.content ?? new Uint8Array(0);
    return { ...base, size: c.length, file: { mimeType: "application/octet-stream", hashes: { quickXorHash: new QuickXorHash().update(c).digestBase64() } } };
  };
  const mk = (a: FakeMsAccount, parentId: string, name: string, folder: boolean, content?: Uint8Array): FakeMsItem => {
    const it: FakeMsItem = { id: `ms${++seq}`, name, parentId, folder: folder || undefined, content, modified: "2026-11-09T12:00:00Z" };
    a.items.set(it.id, it);
    return it;
  };

  const put = (label: string, path: string, content?: string | Uint8Array) => {
    const a = accounts.get(label)!;
    const segs = path.split("/").filter(Boolean);
    let cur = a.items.get(a.rootId)!;
    segs.forEach((seg, i) => {
      const last = i === segs.length - 1;
      const existing = childByName(a, cur.id, seg);
      if (existing) {
        cur = existing;
        return;
      }
      const isFile = last && content !== undefined;
      cur = mk(a, cur.id, seg, !isFile, isFile ? (typeof content === "string" ? new TextEncoder().encode(content) : content) : undefined);
    });
    return cur;
  };

  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const auth = headers.get("Authorization") ?? "";
    log.push({ method, url: url.toString(), auth: !!auth, contentRange: headers.get("Content-Range") ?? undefined });

    if (url.hostname === "login.microsoftonline.com") {
      const form = new URLSearchParams(String(init?.body ?? ""));
      const rt = form.get("refresh_token") ?? form.get("code") ?? "";
      const label = rt.replace(/^rt-/, "").replace(/^code-/, "").replace(/-2$/, "");
      if (!accounts.has(label)) return json({ error: "invalid_grant" }, 400);
      return json({ access_token: `ms-tok-${label}`, expires_in: 3600, refresh_token: opts.rotate ? `rt-${label}-2` : `rt-${label}`, scope: "Files.ReadWrite.All User.Read" });
    }

    // Upload sessions: pre-authenticated, must not carry Authorization.
    if (url.hostname === "upload.fake-1drv.example") {
      const s = sessions.get(url.pathname.slice(1));
      if (!s) return err(404, "itemNotFound", "upload session not found");
      if (auth) return err(401, "unauthenticated", "Authorization header on an upload URL");
      if (method === "GET") return json({ nextExpectedRanges: [`${s.got}-`] });
      const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(headers.get("Content-Range") ?? "");
      if (!range) return err(400, "invalidRequest", "bad Content-Range");
      const body = new Uint8Array(await new Response(init?.body as BodyInit).arrayBuffer());
      log[log.length - 1]!.size = body.length;
      const [start, end, total] = [Number(range[1]), Number(range[2]), Number(range[3])];
      if (s.total === -1) s.total = total;
      if (total !== s.total) return err(400, "invalidRange", "total changed");
      if (start < s.got) return err(416, "invalidRange", "fragment already received");
      if (start !== s.got || end - start + 1 !== body.length) return err(400, "invalidRange", `expected offset ${s.got}`);
      const lastFrag = end + 1 === total;
      if (!lastFrag && body.length % (320 * 1024) !== 0) return err(400, "invalidRange", "fragment not a multiple of 320 KiB");
      s.received.push(body);
      s.got += body.length;
      if (!lastFrag) return json({ nextExpectedRanges: [`${s.got}-`] }, 202);
      sessions.delete(url.pathname.slice(1));
      const a = accounts.get(s.label)!;
      if (childByName(a, s.parentId, s.name)) return err(409, "nameAlreadyExists");
      const all = new Uint8Array(Buffer.concat(s.received));
      if (opts.corruptUploads && all.length) all[all.length - 1] = all[all.length - 1]! ^ 0xff;
      return json(view(a, mk(a, s.parentId, s.name, false, all)), 201);
    }

    if (url.hostname === "dl.fake-1drv.example") {
      const [label, id] = url.pathname.slice(1).split("/");
      const it = accounts.get(label ?? "")?.items.get(id ?? "");
      if (!it?.content) return err(404, "itemNotFound");
      const r = /^bytes=(\d+)-$/.exec(headers.get("Range") ?? "");
      if (r) return new Response(it.content.slice(Number(r[1])) as Uint8Array<ArrayBuffer>, { status: 206 });
      return new Response(it.content as Uint8Array<ArrayBuffer>, { status: 200 });
    }

    if (url.hostname !== "graph.microsoft.com") return new Response("not found", { status: 404 });
    if (opts.throttle && opts.throttle > 0) {
      opts.throttle--;
      return json({ error: { code: "activityLimitReached" } }, 429, { "Retry-After": "1" });
    }
    const label = auth.replace(/^Bearer ms-tok-/, "");
    const a = accounts.get(label);
    if (!a) return err(401, "InvalidAuthenticationToken");
    const p = decodeURI(url.pathname.replace(/^\/v1\.0/, ""));
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;

    if (p === "/me") return json({ mail: `${label}@example.com`, userPrincipalName: `${label}@example.com` });
    if (p === "/me/drive/root") return json(view(a, a.items.get(a.rootId)!));
    let m = /^\/me\/drive\/root:(.*)$/.exec(url.pathname.replace(/^\/v1\.0/, ""));
    if (m) {
      const it = byPath(a, m[1]!.replace(/:$/, ""));
      return it ? json(view(a, it)) : err(404, "itemNotFound");
    }
    const raw = url.pathname.replace(/^\/v1\.0/, "");
    // /me/drive/items/{parent}:/{name}:/createUploadSession and /content, or /me/drive/items/{parent}:/{name}
    m = /^\/me\/drive\/items\/([^/:]+):\/(.+?):?(\/createUploadSession|\/content)?$/.exec(raw);
    if (m) {
      const parent = a.items.get(decodeURIComponent(m[1]!));
      const name = decodeURIComponent(m[2]!.replace(/:$/, ""));
      if (!parent) return err(404, "itemNotFound");
      if (m[3] === "/createUploadSession") {
        const item = (body?.item ?? {}) as Record<string, unknown>;
        if (item["@microsoft.graph.conflictBehavior"] !== "fail") return err(400, "test", "expected conflictBehavior fail");
        if (childByName(a, parent.id, name)) return err(409, "nameAlreadyExists");
        const sid = `s${++seq}`;
        // The total is fixed by the first fragment's Content-Range.
        sessions.set(sid, { label, parentId: parent.id, name, total: -1, received: [], got: 0 });
        return json({ uploadUrl: `https://upload.fake-1drv.example/${sid}`, expirationDateTime: "2026-12-01T00:00:00Z" });
      }
      if (m[3] === "/content" && method === "PUT") {
        if (url.searchParams.get("@microsoft.graph.conflictBehavior") !== "fail") return err(400, "test", "expected conflictBehavior fail");
        if (childByName(a, parent.id, name)) return err(409, "nameAlreadyExists");
        return json(view(a, mk(a, parent.id, name, false, new Uint8Array(0))), 201);
      }
      const it = childByName(a, parent.id, name);
      return it ? json(view(a, it)) : err(404, "itemNotFound");
    }
    m = /^\/me\/drive\/items\/([^/]+)(\/children|\/content)?$/.exec(raw);
    if (m) {
      const it = a.items.get(decodeURIComponent(m[1]!));
      if (!it || it.deleted) return err(404, "itemNotFound");
      if (m[2] === "/children" && method === "GET") {
        const all = children(a, it.id);
        const size = opts.pageSize ?? Number(url.searchParams.get("$top") ?? 200);
        const skip = Number(url.searchParams.get("$skiptoken") ?? 0);
        const page = all.slice(skip, skip + size);
        const next = skip + size < all.length ? `https://graph.microsoft.com/v1.0/me/drive/items/${it.id}/children?$top=${size}&$skiptoken=${skip + size}` : undefined;
        return json({ value: page.map((x) => view(a, x)), ...(next ? { "@odata.nextLink": next } : {}) });
      }
      if (m[2] === "/children" && method === "POST") {
        const name = String(body?.name);
        if (body?.["@microsoft.graph.conflictBehavior"] !== "fail") return err(400, "test", "expected conflictBehavior fail");
        if (childByName(a, it.id, name)) return err(409, "nameAlreadyExists");
        return json(view(a, mk(a, it.id, name, true)), 201);
      }
      if (m[2] === "/content") return new Response(null, { status: 302, headers: { Location: `https://dl.fake-1drv.example/${label}/${it.id}` } });
      if (method === "PATCH") {
        const newParent = (body?.parentReference as { id?: string } | undefined)?.id ?? it.parentId!;
        const newName = typeof body?.name === "string" ? body.name : it.name;
        const clash = childByName(a, newParent, newName);
        if (clash && clash.id !== it.id) return err(409, "nameAlreadyExists");
        it.parentId = newParent;
        it.name = newName;
        return json(view(a, it));
      }
      if (method === "DELETE") {
        it.deleted = true;
        return new Response(null, { status: 204 });
      }
      return json(view(a, it));
    }
    m = /^\/me\/drive\/(?:root|items\/([^/]+))\/search\(q='(.*)'\)$/.exec(p);
    if (m) {
      const q = m[2]!.replace(/''/g, "'").toLowerCase();
      const hits = [...a.items.values()].filter((i) => !i.deleted && i.id !== a.rootId && i.name.toLowerCase().includes(q));
      return json({ value: hits.map((x) => view(a, x)) });
    }
    return err(500, "test", `unexpected ${method} ${raw}`);
  };

  return {
    fetchImpl: fetchImpl as typeof fetch,
    accounts,
    log,
    opts,
    put,
    get: (label, path) => byPath(accounts.get(label)!, path),
    pathOf: (label, id) => pathOfItem(accounts.get(label)!, accounts.get(label)!.items.get(id)!),
  };
}
