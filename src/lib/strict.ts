/**
 * Unknown tool arguments are rejected, never ignored.
 *
 * zod objects strip unknown keys by default, and the MCP SDK validates tool
 * arguments with the tool's inputSchema before the handler runs, so a misnamed
 * argument (`path` where `mkdir` takes `parentPath`) used to vanish silently and
 * the call went ahead with its default, for example the My Drive root.
 *
 * `strictDeep` rebuilds a schema so that every plain object in it (the tool's
 * arguments, batch items, nested targets such as `saveTo`) rejects unknown keys
 * with a message that names the key, lists the accepted ones and suggests the
 * likely intended name. It is applied once, where every tool is registered
 * (guard.ts withResultGuard), so no tool can opt out by accident. Objects that
 * were made deliberately loose (`.loose()`, `.catchall(...)`) are left as they are.
 */
import { z } from "zod";

/** Arguments that exist only on the full-access server; a read-only token gets this explanation instead. */
const UNAVAILABLE: Record<string, string> = {
  saveTo: "saveTo needs a full-access client: this token is read-only, so nothing was saved. Call again without saveTo to read the content.",
  saveAttachmentsTo:
    "saveAttachmentsTo needs a full-access client: this token is read-only, so nothing was saved. Call again without saveAttachmentsTo to read the content.",
};

/** Names clients commonly use for an argument that is spelled differently here. */
const ALIASES: Record<string, string[]> = {
  path: ["parentPath", "toPath", "toFolder", "from", "to"],
  folder: ["folderId", "toFolderId", "parentId", "toFolder", "path"],
  folderid: ["folderId", "toFolderId", "parentId"],
  parent: ["parentPath", "parentId"],
  parentfolder: ["parentPath", "parentId"],
  parentfolderid: ["parentId"],
  to: ["toPath", "toFolderId", "toAccount", "toFolder", "toEmail"],
  destination: ["toPath", "toFolderId", "toFolder", "to"],
  dest: ["toPath", "toFolderId", "toFolder", "to"],
  target: ["toPath", "toFolderId", "targetId", "to"],
  targetpath: ["toPath", "path", "parentPath"],
  from: ["fromAccount", "from"],
  source: ["from", "fileId", "fromAccount"],
  id: ["fileId", "id", "messageId", "threadId"],
  file: ["fileId", "name"],
  filename: ["name", "filename"],
  newname: ["newName"],
  name: ["newName", "name"],
  label: ["account"],
  acct: ["account"],
  accounts: ["account", "accounts"],
  q: ["query"],
  search: ["query"],
  text: ["content", "query"],
  body: ["content", "body"],
  data: ["content", "contentBase64"],
  base64: ["contentBase64"],
  url: ["sourceUrl"],
  dryrun: ["dryRun"],
  dry_run: ["dryRun"],
  ops: ["operations"],
  items: ["operations"],
  cursor: ["resume", "cursor", "pageToken"],
  pagetoken: ["pageToken", "cursor"],
  max: ["limit", "maxFiles", "maxChars"],
};

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]!;
      dp[j] = Math.min(dp[j]! + 1, dp[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length]!;
}

/** Accepted keys that the unknown `key` most likely meant, best first (at most three). */
export function suggestKeys(key: string, accepted: string[]): string[] {
  const k = key.toLowerCase();
  const out: string[] = [];
  const add = (s: string) => {
    if (accepted.includes(s) && !out.includes(s)) out.push(s);
  };
  for (const s of accepted) if (s.toLowerCase() === k) add(s);
  for (const s of ALIASES[k] ?? []) add(s);
  for (const s of accepted) if (k.length >= 3 && s.toLowerCase().includes(k)) add(s);
  for (const s of accepted) if (editDistance(k, s.toLowerCase()) <= Math.max(1, Math.floor(s.length / 4))) add(s);
  return out.slice(0, 3);
}

/** The message for unknown keys on an object that accepts `accepted`. */
export function unknownKeysMessage(keys: string[], accepted: string[]): string {
  const known = keys.map((k) => UNAVAILABLE[k]).filter((m): m is string => !!m);
  if (known.length === keys.length) return known.join(" ");
  const parts = keys
    .filter((k) => !UNAVAILABLE[k])
    .map((k) => {
      const hint = suggestKeys(k, accepted);
      return `"${k}"${hint.length ? ` (did you mean ${hint.map((h) => `"${h}"`).join(" or ")}?)` : ""}`;
    });
  const list = accepted.length ? accepted.join(", ") : "none";
  return [
    `unknown argument${parts.length > 1 ? "s" : ""} ${parts.join(", ")}; nothing was done. Accepted arguments: ${list}.`,
    ...known,
  ].join(" ");
}

type AnyDef = Record<string, unknown> & { type: string };
const defOf = (s: z.ZodType) => (s as unknown as { _zod: { def: AnyDef } })._zod.def;

/** Keep `.describe()` / `.meta()` (stored in the global registry, keyed by instance) on the rebuilt schema. */
function rebuilt<T extends z.ZodType>(old: T, def: AnyDef): T {
  const next = old.clone(z.core.util.mergeDefs(defOf(old), def) as never) as T;
  const meta = z.globalRegistry.get(old);
  if (meta) z.globalRegistry.add(next, meta);
  return next;
}

const seen = new WeakMap<z.ZodType, z.ZodType>();

/** A copy of `schema` in which every non-loose object rejects unknown keys (see the module comment). */
export function strictDeep<T extends z.ZodType>(schema: T): T {
  const cached = seen.get(schema);
  if (cached) return cached as T;
  const out = strictInner(schema);
  seen.set(schema, out);
  return out as T;
}

function strictInner(s: z.ZodType): z.ZodType {
  const def = defOf(s);
  const map = (c: unknown) => (c ? strictDeep(c as z.ZodType) : c);
  switch (def.type) {
    case "object": {
      const shape = def.shape as Record<string, z.ZodType>;
      const nextShape: Record<string, z.ZodType> = {};
      let changed = false;
      for (const [k, v] of Object.entries(shape)) {
        nextShape[k] = strictDeep(v);
        if (nextShape[k] !== v) changed = true;
      }
      const loose = def.catchall !== undefined;
      if (loose && !changed) return s;
      const accepted = Object.keys(shape);
      const prevError = def.error as ((iss: unknown) => unknown) | undefined;
      return rebuilt(s, {
        type: "object",
        shape: nextShape,
        ...(loose
          ? {}
          : {
              catchall: z.never(),
              error: (iss: { code?: string; keys?: string[] }) =>
                iss.code === "unrecognized_keys" && iss.keys ? unknownKeysMessage(iss.keys, accepted) : prevError?.(iss),
            }),
      });
    }
    case "optional":
    case "nullable":
    case "default":
    case "prefault":
    case "catch":
    case "readonly":
    case "nonoptional": {
      const inner = map(def.innerType);
      return inner === def.innerType ? s : rebuilt(s, { type: def.type, innerType: inner });
    }
    case "array": {
      const el = map(def.element);
      return el === def.element ? s : rebuilt(s, { type: "array", element: el });
    }
    case "union": {
      const options = (def.options as z.ZodType[]).map((o) => strictDeep(o));
      return options.every((o, i) => o === (def.options as z.ZodType[])[i]) ? s : rebuilt(s, { type: "union", options });
    }
    case "pipe": {
      const a = map(def.in);
      const b = map(def.out);
      return a === def.in && b === def.out ? s : rebuilt(s, { type: "pipe", in: a, out: b });
    }
    case "intersection": {
      const l = map(def.left);
      const r = map(def.right);
      return l === def.left && r === def.right ? s : rebuilt(s, { type: "intersection", left: l, right: r });
    }
    case "record": {
      const v = map(def.valueType);
      return v === def.valueType ? s : rebuilt(s, { type: "record", valueType: v });
    }
    default:
      return s;
  }
}
