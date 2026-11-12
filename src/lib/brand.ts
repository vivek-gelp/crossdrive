// Crossdrive's name, logo files and how they are advertised: the HTML <link> tags (app/layout.tsx), the web app
// manifest (app/manifest.ts) and the MCP `serverInfo` returned by `initialize` (app/api/mcp/route.ts).
// The image files live in public/ and are generated from public/brand/crossdrive-mark.svg by scripts/make-icons.mjs.
import type { Implementation } from "@modelcontextprotocol/server";
import { VERSION } from "./config";

export const NAME = "Crossdrive";
export const DESCRIPTION =
  "A self-hosted MCP server that gives your AI one safe connection to every Google Drive and Gmail account you own, plus OneDrive and Dropbox in beta.";

export interface IconFile {
  path: string;
  mimeType: "image/png" | "image/svg+xml" | "image/x-icon";
  /** `"any"` for scalable images; otherwise WxH values, as in the HTML `sizes` attribute and the MCP Icon type. */
  sizes: string[];
}

/** Every icon file served from public/. Paths are public (no auth) and must match the files the script writes. */
export const ICON_FILES = {
  ico: { path: "/favicon.ico", mimeType: "image/x-icon", sizes: ["16x16", "32x32", "48x48", "256x256"] },
  svg: { path: "/icon.svg", mimeType: "image/svg+xml", sizes: ["any"] },
  png32: { path: "/icon-32.png", mimeType: "image/png", sizes: ["32x32"] },
  png48: { path: "/icon-48.png", mimeType: "image/png", sizes: ["48x48"] },
  png192: { path: "/icon-192.png", mimeType: "image/png", sizes: ["192x192"] },
  png512: { path: "/icon-512.png", mimeType: "image/png", sizes: ["512x512"] },
  apple: { path: "/apple-touch-icon.png", mimeType: "image/png", sizes: ["180x180"] },
} as const satisfies Record<string, IconFile>;

/**
 * MCP `Implementation.icons` (spec 2025-11-25, SEP-973). PNG first, because clients that render icons must support
 * PNG and only should support SVG. Icons are omitted unless the base URL is https: the spec tells clients to reject
 * any other scheme, so advertising http://localhost icons would only produce failed fetches.
 */
export function mcpIcons(base: string): NonNullable<Implementation["icons"]> {
  if (!/^https:\/\//i.test(base)) return [];
  const b = base.replace(/\/$/, "");
  return [ICON_FILES.png48, ICON_FILES.png192, ICON_FILES.png512, ICON_FILES.svg].map((f) => ({
    src: `${b}${f.path}`,
    mimeType: f.mimeType,
    sizes: [...f.sizes],
  }));
}

/**
 * The server identity returned in the `initialize` result. `title`, `icons`, `websiteUrl` and `description` were
 * added to `Implementation` in MCP 2025-06-18 / 2025-11-25; older clients ignore fields they do not know.
 */
export function mcpServerInfo(base: string): Implementation {
  const b = base.replace(/\/$/, "");
  const icons = mcpIcons(b);
  return {
    name: "crossdrive",
    title: NAME,
    version: VERSION,
    description: DESCRIPTION,
    websiteUrl: `${b}/`,
    ...(icons.length > 0 && { icons }),
  };
}
