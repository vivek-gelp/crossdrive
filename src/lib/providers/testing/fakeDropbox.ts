/**
 * In-memory fake of the Dropbox API v2 routes the adapter uses, plus the
 * OAuth token endpoint. Multi-account: bearer `dbx-tok-<label>`, refresh
 * token `rt-<label>`. Paths are case-insensitive; errors are 409 with an
 * `error_summary` like the real API. Checks that Dropbox-API-Arg is ASCII.
 */
import { DropboxContentHash } from "../hash";

export interface FakeDbxItem {
  id: string;
  /** Display path, e.g. `/Projects/a.txt`. */
  path: string;
  folder: boolean;
  content?: Uint8Array;
  deleted?: boolean;
}

export interface FakeDbxOpts {
  pageSize?: number;
  /** Answer the next N API requests with 429 + Retry-After: 1. */
  throttle?: number;
}

export interface FakeDropbox {
  fetchImpl: typeof fetch;
  accounts: Map<string, Map<string, FakeDbxItem>>;
  log: { route: string; arg?: unknown }[];
  opts: FakeDbxOpts;
  put(label: string, path: string, content?: string | Uint8Array): FakeDbxItem;
  get(label: string, path: string): FakeDbxItem | undefined;
}

let seq = 0;
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
const e409 = (summary: string) => json({ error_summary: summary, error: { ".tag": summary.split("/")[0] } }, 409);
const lower = (p: string) => p.toLowerCase();
const parentOf = (p: string) => (p.lastIndexOf("/") <= 0 ? "" : p.slice(0, p.lastIndexOf("/")));
const nameOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);

export function fakeDropbox(labels: string[], opts: FakeDbxOpts = {}): FakeDropbox {
  const accounts = new Map<string, Map<string, FakeDbxItem>>(labels.map((l) => [l, new Map()]));
  const log: FakeDropbox["log"] = [];
  const sessions = new Map<string, { label: string; parts: Uint8Array[]; got: number }>();

  const live = (acc: Map<string, FakeDbxItem>) => [...acc.values()].filter((i) => !i.deleted);
  const resolve = (acc: Map<string, FakeDbxItem>, p: string): FakeDbxItem | undefined => {
    if (p.startsWith("id:")) return live(acc).find((i) => i.id === p);
    return live(acc).find((i) => lower(i.path) === lower(p));
  };
  const meta = (i: FakeDbxItem) => {
    const base = { name: nameOf(i.path), id: i.id, path_lower: lower(i.path), path_display: i.path };
    if (i.folder) return { ".tag": "folder", ...base };
    const c = i.content ?? new Uint8Array(0);
    return { ".tag": "file", ...base, size: c.length, server_modified: "2026-11-09T12:00:00Z", content_hash: new DropboxContentHash().update(c).digestHex() };
  };
  const add = (acc: Map<string, FakeDbxItem>, path: string, folder: boolean, content?: Uint8Array) => {
    const it: FakeDbxItem = { id: `id:d${++seq}`, path, folder, content };
    acc.set(it.id, it);
    return it;
  };
  const ensureParents = (acc: Map<string, FakeDbxItem>, path: string) => {
    const segs = path.split("/").filter(Boolean);
    let cur = "";
    for (const s of segs.slice(0, -1)) {
      cur += `/${s}`;
      if (!resolve(acc, cur)) add(acc, cur, true);
    }
  };

  const put = (label: string, path: string, content?: string | Uint8Array) => {
    const acc = accounts.get(label)!;
    ensureParents(acc, path);
    const existing = resolve(acc, path);
    if (existing) return existing;
    return add(acc, path, content === undefined, content === undefined ? undefined : typeof content === "string" ? new TextEncoder().encode(content) : content);
  };

  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    if (url.pathname === "/oauth2/token") {
      const form = new URLSearchParams(String(init?.body ?? ""));
      const label = (form.get("refresh_token") ?? form.get("code") ?? "").replace(/^(rt|code)-/, "");
      if (!accounts.has(label)) return json({ error: "invalid_grant" }, 400);
      return json({ access_token: `dbx-tok-${label}`, expires_in: 14400, refresh_token: `rt-${label}`, scope: "files.content.read files.content.write" });
    }
    const route = url.pathname.replace(/^\/2\//, "");
    const argHeader = headers.get("Dropbox-API-Arg");
    if (argHeader && /[^\x20-\x7e]/.test(argHeader)) return new Response("Dropbox-API-Arg must be ASCII", { status: 400 });
    const arg = (argHeader ? JSON.parse(argHeader) : init?.body && url.hostname === "api.dropboxapi.com" ? JSON.parse(String(init.body)) : undefined) as Record<string, unknown> | undefined;
    log.push({ route, arg });
    if (opts.throttle && opts.throttle > 0) {
      opts.throttle--;
      return json({ error_summary: "too_many_requests/..", error: { reason: { ".tag": "too_many_requests" } } }, 429, { "Retry-After": "1" });
    }
    const label = (headers.get("Authorization") ?? "").replace(/^Bearer dbx-tok-/, "");
    const acc = accounts.get(label);
    if (!acc) return new Response("bad token", { status: 401 });
    const path = typeof arg?.path === "string" ? (arg.path as string) : undefined;

    switch (route) {
      case "users/get_current_account":
        return json({ account_id: `dbid:${label}`, email: `${label}@example.com` });
      case "files/get_metadata": {
        const it = resolve(acc, path!);
        return it ? json(meta(it)) : e409("path/not_found/..");
      }
      case "files/list_folder":
      case "files/list_folder/continue": {
        let folderPath: string;
        let start = 0;
        if (route === "files/list_folder") {
          folderPath = path === "" ? "" : (resolve(acc, path!)?.path ?? "\u0000");
          if (folderPath === "\u0000") return e409("path/not_found/..");
        } else {
          const c = JSON.parse(Buffer.from(String(arg!.cursor), "base64url").toString()) as { p: string; s: number };
          folderPath = c.p;
          start = c.s;
        }
        const all = live(acc)
          .filter((i) => lower(parentOf(i.path)) === lower(folderPath))
          .sort((a, b) => a.path.localeCompare(b.path));
        const size = opts.pageSize ?? Number(arg?.limit ?? 500);
        const page = all.slice(start, start + size);
        const cursor = Buffer.from(JSON.stringify({ p: folderPath, s: start + size })).toString("base64url");
        return json({ entries: page.map(meta), cursor, has_more: start + size < all.length });
      }
      case "files/search_v2": {
        const q = String(arg!.query).toLowerCase();
        return json({ matches: live(acc).filter((i) => nameOf(i.path).toLowerCase().includes(q)).map((i) => ({ metadata: { ".tag": "metadata", metadata: meta(i) } })), has_more: false });
      }
      case "files/create_folder_v2": {
        if (resolve(acc, path!)) return e409("path/conflict/folder/..");
        if (parentOf(path!) && !resolve(acc, parentOf(path!))) return e409("path/not_found/..");
        const m = meta(add(acc, path!, true)) as Record<string, unknown>;
        delete m[".tag"];
        return json({ metadata: m });
      }
      case "files/move_v2": {
        const it = resolve(acc, String(arg!.from_path));
        if (!it) return e409("from_lookup/not_found/..");
        const to = String(arg!.to_path);
        const clash = resolve(acc, to);
        if (clash && clash.id !== it.id) return e409("to/conflict/file/..");
        const old = it.path;
        for (const x of live(acc)) if (lower(x.path).startsWith(`${lower(old)}/`)) x.path = to + x.path.slice(old.length);
        it.path = to;
        return json({ metadata: meta(it) });
      }
      case "files/delete_v2": {
        const it = resolve(acc, path!);
        if (!it) return e409("path_lookup/not_found/..");
        for (const x of live(acc)) if (x === it || lower(x.path).startsWith(`${lower(it.path)}/`)) x.deleted = true;
        return json({ metadata: meta(it) });
      }
      case "files/download": {
        const it = resolve(acc, path!);
        if (!it || it.folder) return e409("path/not_found/..");
        const c = it.content ?? new Uint8Array(0);
        const r = /^bytes=(\d+)-$/.exec(headers.get("Range") ?? "");
        const body = r ? c.slice(Number(r[1])) : c;
        return new Response(body as Uint8Array<ArrayBuffer>, { status: r ? 206 : 200, headers: { "Dropbox-API-Result": JSON.stringify(meta(it)) } });
      }
      case "upload_session/start": {
        const id = `sess${++seq}`;
        const body = new Uint8Array(await new Response(init?.body as BodyInit).arrayBuffer());
        sessions.set(id, { label, parts: body.length ? [body] : [], got: body.length });
        return json({ session_id: id });
      }
      case "upload_session/append_v2": {
        const cur = arg!.cursor as { session_id: string; offset: number };
        const s = sessions.get(cur.session_id);
        if (!s) return e409("lookup_failed/not_found/");
        if (cur.offset !== s.got) return json({ error_summary: `lookup_failed/incorrect_offset/${s.got}`, error: { ".tag": "lookup_failed", lookup_failed: { ".tag": "incorrect_offset", correct_offset: s.got } } }, 409);
        const body = new Uint8Array(await new Response(init?.body as BodyInit).arrayBuffer());
        if (body.length > 150 * 1024 * 1024) return new Response("too big", { status: 400 });
        s.parts.push(body);
        s.got += body.length;
        return new Response("null", { status: 200, headers: { "Content-Type": "application/json" } });
      }
      case "upload_session/finish": {
        const cur = arg!.cursor as { session_id: string; offset: number };
        const commit = arg!.commit as { path: string; mode: string; autorename: boolean; strict_conflict?: boolean };
        const s = sessions.get(cur.session_id);
        if (!s) return e409("lookup_failed/not_found/");
        if (cur.offset !== s.got) return e409(`lookup_failed/incorrect_offset/${s.got}`);
        if (commit.mode !== "add" || commit.autorename !== false) return new Response("test: expected add without autorename", { status: 400 });
        if (resolve(acc, commit.path)) return e409("path/conflict/file/..");
        ensureParents(acc, commit.path);
        sessions.delete(cur.session_id);
        const m = meta(add(acc, commit.path, false, new Uint8Array(Buffer.concat(s.parts)))) as Record<string, unknown>;
        delete m[".tag"];
        return json(m);
      }
    }
    return new Response(`unexpected ${route}`, { status: 500 });
  };

  return { fetchImpl: fetchImpl as typeof fetch, accounts, log, opts, put, get: (label, p) => resolve(accounts.get(label)!, p) };
}
