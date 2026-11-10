/**
 * Test-only fake of the Google Drive v3 REST surface the server uses, for
 * handler-level tests of the tools. Several accounts share one file table;
 * the bearer token (`tok-<label>`) selects the acting account, and a file is
 * visible to an account when it owns it, has a permission on it, or the file
 * lives in a Shared Drive the account is a member of.
 *
 * No vitest imports here so the module can be loaded from `vi.mock` factories.
 */
import type { DriveFile, Permission, SharedDrive } from "../drive";
import type { Account, TextStore } from "../store";

export interface FakeAccountSpec {
  label: string;
  email: string;
  drives?: SharedDrive[];
  /** Granted scope short names; default ["drive"] (no Gmail). */
  scopes?: string[];
}

export interface FakeFile extends DriveFile {
  /** Explicit sharing besides the owner: email -> role. */
  perms?: Record<string, "reader" | "commenter" | "writer" | "owner">;
  /** True when this item appears in the account's "Shared with me" list (set for top-level shared folders). */
  sharedWithMe?: boolean;
  /** Bytes served for `alt=media` downloads (utf8). Google-native files export as `PDF(<name>)`. */
  content?: string;
}

export interface Recorded {
  method: string;
  path: string;
  params: URLSearchParams;
  body: unknown;
  account: string;
}

export interface FakeUploadSession {
  account: string;
  meta: { name: string; parents: string[]; mimeType?: string };
  contentType: string;
  /** From X-Upload-Content-Length, when given. */
  declaredSize?: number;
  received: Uint8Array[];
  receivedBytes: number;
  /** Content-Range headers of every PUT, in order. */
  ranges: string[];
  fileId?: string;
}

export interface FakeDrive {
  fetchImpl: typeof fetch;
  files: Record<string, FakeFile>;
  permissions: Record<string, Permission[]>;
  log: Recorded[];
  /** Queries (`q`) of every files.list call, in order. */
  queries: string[];
  /** Resumable upload sessions by upload_id. */
  sessions: Record<string, FakeUploadSession>;
}

export function memoryStore(): TextStore {
  const data = new Map<string, string>();
  return {
    kind: "memory",
    read: async (p) => data.get(p) ?? null,
    write: async (p, t) => void data.set(p, t),
    listPaths: async (prefix) => [...data.keys()].filter((k) => k.startsWith(prefix)).sort(),
  };
}

/** Overrides for `vi.mock("./store")`: accounts with bearer tokens `tok-<label>`. */
export function storeMock(specs: FakeAccountSpec[]) {
  const accounts: Account[] = specs.map((s) => ({
    label: s.label as Account["label"],
    email: s.email,
    refresh_token: "r",
    connectedAt: "2026-01-01T00:00:00Z",
    scopes: s.scopes ?? ["drive"],
  }));
  return {
    accessTokenFor: async (a: Account) => `tok-${a.label}`,
    getAccount: async (label: string) => {
      const a = accounts.find((x) => x.label === label);
      if (!a) throw new Error(`No connected account labelled "${label}" (connected: ${accounts.map((x) => x.label).join(", ")})`);
      return a;
    },
    loadAccounts: async () => accounts,
  };
}

let seq = 0;
const nextId = (prefix: string) => `${prefix}${++seq}`;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export interface FakeDriveOpts {
  failPatchWith?: number;
  /** `files.copy` of these source ids fails with `failCopyStatus` (default 500), to exercise per-item failure reporting. */
  failCopyIds?: string[];
  failCopyStatus?: number;
  /**
   * Simulate Drive's asynchronous permission propagation: a role inherited from a parent folder becomes visible to an
   * account only from its (inheritDelay + 1)-th files.get / files.copy request for that file onwards.
   */
  inheritDelay?: number;
  /** Serve non-Google URLs (e.g. a `sourceUrl` for put); undefined falls through to a 404. */
  external?: (url: URL, init?: RequestInit) => Response | Promise<Response> | undefined;
}

export function fakeDrive(specs: FakeAccountSpec[], files: Record<string, FakeFile>, opts: FakeDriveOpts = {}): FakeDrive {
  const permissions: Record<string, Permission[]> = {};
  const log: Recorded[] = [];
  const queries: string[] = [];
  const sessions: Record<string, FakeUploadSession> = {};

  const byLabel = new Map(specs.map((s) => [s.label, s]));
  /** `${email}:${fileId}` -> number of direct requests for that file, for inheritDelay. */
  const attempts = new Map<string, number>();
  // Permissions are inherited from parent folders, as in Drive.
  const roleOf = (f: FakeFile, email: string, depth = 0): string | undefined => {
    const owner = f.owners?.[0]?.emailAddress?.toLowerCase();
    if (owner === email) return "owner";
    const explicit = f.perms?.[email];
    if (explicit) return explicit;
    const p = permissions[f.id]?.find((x) => x.emailAddress?.toLowerCase() === email);
    if (p?.role) return p.role;
    if (depth > 16) return undefined;
    if (opts.inheritDelay && depth === 0 && (attempts.get(`${email}:${f.id}`) ?? 0) <= opts.inheritDelay) return undefined;
    for (const parentId of f.parents ?? []) {
      const parent = files[parentId];
      const r = parent ? roleOf(parent, email, depth + 1) : undefined;
      if (r) return r === "owner" ? "writer" : r;
    }
    return undefined;
  };
  const memberOfDrive = (spec: FakeAccountSpec, driveId?: string) => !!driveId && (spec.drives ?? []).some((d) => d.id === driveId);
  const visible = (spec: FakeAccountSpec, f: FakeFile) => roleOf(f, spec.email) !== undefined || memberOfDrive(spec, f.driveId);
  const view = (spec: FakeAccountSpec, f: FakeFile): DriveFile => {
    const { perms, sharedWithMe, ...rest } = f;
    void perms;
    void sharedWithMe;
    if (rest.capabilities) return rest;
    const role = roleOf(f, spec.email);
    const edit = role === "owner" || role === "writer" || memberOfDrive(spec, f.driveId);
    return { ...rest, capabilities: { canEdit: edit, canAddChildren: edit, canShare: edit } };
  };

  const matches = (spec: FakeAccountSpec, f: FakeFile, q: string): boolean => {
    if (!visible(spec, f)) return false;
    if (q.includes("trashed = false") && f.trashed) return false;
    const parents = [...q.matchAll(/'([^']+)' in parents/g)].map((m) => m[1]!);
    if (parents.length && !parents.some((p) => f.parents?.includes(p))) return false;
    const eq = /name = '((?:[^'\\]|\\.)*)'/.exec(q);
    if (eq && f.name !== eq[1]!.replace(/\\(.)/g, "$1")) return false;
    const contains = /name contains '((?:[^'\\]|\\.)*)'/.exec(q);
    if (contains && !f.name.toLowerCase().includes(contains[1]!.replace(/\\(.)/g, "$1").toLowerCase())) return false;
    const mimeEq = /mimeType = '([^']+)'/.exec(q);
    if (mimeEq && f.mimeType !== mimeEq[1]) return false;
    const mimeNe = /mimeType != '([^']+)'/.exec(q);
    if (mimeNe && f.mimeType === mimeNe[1]) return false;
    if (q.includes("sharedWithMe = true") && !f.sharedWithMe) return false;
    if (q.includes("'me' in owners") && f.owners?.[0]?.emailAddress?.toLowerCase() !== spec.email) return false;
    const after = /modifiedTime > '([^']+)'/.exec(q);
    if (after && !((f.modifiedTime ?? "") > after[1]!)) return false;
    return true;
  };

  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    if (!/googleapis\.com$/.test(url.hostname) && url.hostname !== "localhost") {
      const r = await opts.external?.(url, init);
      return r ?? new Response("not found", { status: 404 });
    }
    const reqHeaders = new Headers(init?.headers);
    const p = url.pathname;

    // Resumable upload sessions: the PUTs carry no bearer token (the session URL is the credential).
    if (p === "/upload/drive/v3/files" && url.searchParams.get("uploadType") === "resumable" && method === "PUT") {
      const s = sessions[url.searchParams.get("upload_id") ?? ""];
      if (!s) return json({ error: { message: "Upload session not found" } }, 404);
      const range = reqHeaders.get("Content-Range") ?? "";
      s.ranges.push(range);
      log.push({ method, path: p, params: url.searchParams, body: range, account: s.account });
      const spec = byLabel.get(s.account)!;
      const query = /^bytes \*\/(\d+|\*)$/.exec(range);
      const m = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(range);
      if (!query && !m) return json({ error: { message: `Bad Content-Range ${range}` } }, 400);
      const totalText = query?.[1] ?? m?.[3];
      const total: number | undefined = totalText === "*" ? undefined : Number(totalText);
      if (m) {
        const chunk = new Uint8Array(await new Response(init?.body as BodyInit).arrayBuffer());
        if (Number(m[1]) !== s.receivedBytes) return json({ error: { message: `Expected offset ${s.receivedBytes}, got ${m[1]}` } }, 400);
        if (chunk.length !== Number(m[2]) - Number(m[1]) + 1) return json({ error: { message: `Content-Range ${range} does not match body of ${chunk.length} bytes` } }, 400);
        if ((total === undefined || s.receivedBytes + chunk.length < total) && chunk.length % (256 * 1024) !== 0) {
          return json({ error: { message: `Non-final chunk of ${chunk.length} bytes is not a multiple of 256 KiB` } }, 400);
        }
        s.received.push(chunk);
        s.receivedBytes += chunk.length;
      }
      if (total === undefined || s.receivedBytes < total) {
        return new Response(null, { status: 308, headers: s.receivedBytes ? { Range: `bytes=0-${s.receivedBytes - 1}` } : {} });
      }
      if (s.fileId) return json(view(spec, files[s.fileId]!));
      const id = nextId("up");
      const parent = files[s.meta.parents[0]!];
      const all = Buffer.concat(s.received.map((c) => Buffer.from(c)));
      const f: FakeFile = {
        id,
        name: s.meta.name,
        mimeType: s.meta.mimeType ?? s.contentType,
        parents: s.meta.parents,
        size: String(all.length),
        content: all.toString("utf8"),
        owners: parent?.driveId ? undefined : [{ emailAddress: spec.email }],
        driveId: parent?.driveId,
        modifiedTime: "2026-11-09T12:00:00.000Z",
      };
      files[id] = f;
      s.fileId = id;
      return json(view(spec, f));
    }

    const auth = reqHeaders.get("Authorization") ?? "";
    const label = auth.replace(/^Bearer tok-/, "");
    const spec = byLabel.get(label);
    if (!spec) return json({ error: { message: `unknown token for ${label}` } }, 401);
    const body = init?.body && typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    log.push({ method, path: url.pathname, params: url.searchParams, body, account: label });
    const direct = /^\/drive\/v3\/files\/([^/]+)(?:\/copy)?$/.exec(p);
    if (direct && direct[1] !== "root") {
      const k = `${spec.email}:${decodeURIComponent(direct[1]!)}`;
      attempts.set(k, (attempts.get(k) ?? 0) + 1);
    }

    if (p === "/upload/drive/v3/files" && method === "POST") {
      const kind = url.searchParams.get("uploadType");
      if (kind === "resumable") {
        const meta = body as FakeUploadSession["meta"];
        const parent = files[meta.parents[0]!];
        if (!parent || !visible(spec, parent)) return json({ error: { message: "Parent not found" } }, 404);
        const id = nextId("session");
        const declared = reqHeaders.get("X-Upload-Content-Length");
        sessions[id] = {
          account: label,
          meta,
          contentType: reqHeaders.get("X-Upload-Content-Type") ?? "application/octet-stream",
          declaredSize: declared ? Number(declared) : undefined,
          received: [],
          receivedBytes: 0,
          ranges: [],
        };
        return new Response(null, { status: 200, headers: { Location: `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=${id}` } });
      }
      if (kind === "multipart") {
        const raw = Buffer.from(init?.body as Uint8Array);
        const text = raw.toString("latin1");
        const boundary = /boundary=(.+)$/.exec(reqHeaders.get("Content-Type") ?? "")?.[1] ?? "";
        const parts = text.split(`--${boundary}`);
        const metaPart = parts[1] ?? "";
        const dataPart = parts[2] ?? "";
        const meta = JSON.parse(metaPart.slice(metaPart.indexOf("\r\n\r\n") + 4).trim()) as FakeUploadSession["meta"];
        const ctype = /Content-Type: ([^\r\n]+)/.exec(dataPart)?.[1] ?? "application/octet-stream";
        const dataStart = dataPart.indexOf("\r\n\r\n") + 4;
        const data = Buffer.from(dataPart.slice(dataStart, dataPart.length - 2), "latin1");
        const parent = files[meta.parents[0]!];
        if (!parent || !visible(spec, parent)) return json({ error: { message: "Parent not found" } }, 404);
        const id = nextId("up");
        const f: FakeFile = {
          id,
          name: meta.name,
          mimeType: meta.mimeType ?? ctype,
          parents: meta.parents,
          size: String(data.length),
          content: data.toString("utf8"),
          owners: parent.driveId ? undefined : [{ emailAddress: spec.email }],
          driveId: parent.driveId,
          modifiedTime: "2026-11-09T12:00:00.000Z",
        };
        files[id] = f;
        return json(view(spec, f));
      }
    }

    if (p === "/drive/v3/about") return json({ user: { emailAddress: spec.email.toUpperCase() }, storageQuota: { usage: "1", limit: "2" } });
    if (p === "/drive/v3/files/root") {
      // The account's My Drive root: its parentless folder named "My Drive", else "root".
      const r = Object.values(files).find((f) => !f.parents && !f.driveId && f.name === "My Drive" && f.owners?.[0]?.emailAddress?.toLowerCase() === spec.email);
      return json({ id: r?.id ?? "root" });
    }
    if (p === "/drive/v3/drives") return json({ drives: spec.drives ?? [] });

    if (p === "/drive/v3/files" && method === "GET") {
      const q = url.searchParams.get("q") ?? "";
      queries.push(q);
      let out = Object.values(files).filter((f) => matches(spec, f, q));
      const orderBy = url.searchParams.get("orderBy") ?? "";
      if (orderBy.startsWith("modifiedTime desc")) out.sort((a, b) => (b.modifiedTime ?? "").localeCompare(a.modifiedTime ?? ""));
      const pageSize = Number(url.searchParams.get("pageSize") ?? "100");
      const offset = Number(url.searchParams.get("pageToken") ?? "0");
      const page = out.slice(offset, offset + pageSize);
      out = page;
      const nextPageToken = offset + pageSize < Object.values(files).filter((f) => matches(spec, f, q)).length ? String(offset + pageSize) : undefined;
      return json({ files: out.map((f) => view(spec, f)), nextPageToken });
    }
    if (p === "/drive/v3/files" && method === "POST") {
      const b = body as { name: string; mimeType: string; parents: string[]; shortcutDetails?: { targetId: string } };
      const id = nextId("new");
      const parent = files[b.parents[0]!];
      const f: FakeFile = {
        id,
        name: b.name,
        mimeType: b.mimeType,
        parents: b.parents,
        owners: parent?.driveId ? undefined : [{ emailAddress: spec.email }],
        driveId: parent?.driveId,
        modifiedTime: "2026-11-09T12:00:00.000Z",
        shortcutDetails: b.shortcutDetails,
      };
      files[id] = f;
      return json(view(spec, f));
    }

    const copyM = /^\/drive\/v3\/files\/([^/]+)\/copy$/.exec(p);
    if (copyM && method === "POST") {
      const src = files[decodeURIComponent(copyM[1]!)];
      if (!src || !visible(spec, src)) return json({ error: { message: "File not found" } }, 404);
      if (opts.failCopyIds?.includes(src.id)) return json({ error: { message: "This file cannot be copied" } }, opts.failCopyStatus ?? 500);
      const b = body as { name?: string; parents: string[] };
      const id = nextId("copy");
      const parent = files[b.parents[0]!];
      const f: FakeFile = {
        id,
        name: b.name ?? src.name,
        mimeType: src.mimeType,
        size: src.size,
        md5Checksum: src.md5Checksum,
        parents: b.parents,
        owners: parent?.driveId ? undefined : [{ emailAddress: spec.email }],
        driveId: parent?.driveId,
        modifiedTime: "2026-11-09T12:00:00.000Z",
      };
      files[id] = f;
      return json(view(spec, f));
    }

    const exportM = /^\/drive\/v3\/files\/([^/]+)\/export$/.exec(p);
    if (exportM) {
      const f = files[decodeURIComponent(exportM[1]!)];
      if (!f || !visible(spec, f)) return json({ error: { message: "File not found" } }, 404);
      const mime = url.searchParams.get("mimeType") ?? "application/pdf";
      return new Response(`PDF(${f.name})`, { status: 200, headers: { "Content-Type": mime } });
    }

    const permM = /^\/drive\/v3\/files\/([^/]+)\/permissions(?:\/([^/]+))?$/.exec(p);
    if (permM) {
      const fileId = decodeURIComponent(permM[1]!);
      const f = files[fileId];
      if (!f || !visible(spec, f)) return json({ error: { message: "File not found" } }, 404);
      const list = (permissions[fileId] ??= [
        { id: "owner-perm", type: "user", role: "owner", emailAddress: f.owners?.[0]?.emailAddress, displayName: "Owner" },
        ...Object.entries(f.perms ?? {}).map(([email, role], i) => ({ id: `seed${i}`, type: "user", role, emailAddress: email })),
      ]);
      const permId = permM[2] ? decodeURIComponent(permM[2]) : undefined;
      if (!permId && method === "GET") return json({ permissions: list });
      if (!permId && method === "POST") {
        const b = body as { type: string; role: string; emailAddress?: string };
        const transfer = url.searchParams.get("transferOwnership") === "true";
        if (transfer) {
          for (const x of list) if (x.role === "owner") x.role = "writer";
          f.owners = [{ emailAddress: b.emailAddress }];
        }
        const created: Permission = { id: nextId("perm"), type: b.type, role: b.role, emailAddress: b.emailAddress };
        list.push(created);
        return json(created);
      }
      const target = list.find((x) => x.id === permId);
      if (!target) return json({ error: { message: "Permission not found" } }, 404);
      if (method === "PATCH") {
        Object.assign(target, body as Partial<Permission>);
        return json(target);
      }
      if (method === "DELETE") {
        permissions[fileId] = list.filter((x) => x.id !== permId);
        return new Response(null, { status: 204 });
      }
    }

    const idM = /^\/drive\/v3\/files\/([^/]+)$/.exec(p);
    if (idM) {
      const id = decodeURIComponent(idM[1]!);
      const f = files[id];
      if (!f || !visible(spec, f)) return json({ error: { message: `File not found: ${id}` } }, 404);
      if (method === "GET" && url.searchParams.get("alt") === "media") {
        return new Response(f.content ?? "", { status: 200, headers: { "Content-Type": f.mimeType } });
      }
      if (method === "PATCH") {
        if (opts.failPatchWith) return json({ error: { message: "The user does not have sufficient permissions for this file." } }, opts.failPatchWith);
        const b = (body ?? {}) as Record<string, unknown>;
        if (typeof b.name === "string") f.name = b.name;
        if (typeof b.trashed === "boolean") f.trashed = b.trashed;
        const add = url.searchParams.get("addParents");
        if (add) f.parents = [add];
        return json(view(spec, f));
      }
      return json(view(spec, f));
    }
    return json({ error: { message: `unexpected ${method} ${p}` } }, 500);
  };

  return { fetchImpl: fetchImpl as typeof fetch, files, permissions, log, queries, sessions };
}
