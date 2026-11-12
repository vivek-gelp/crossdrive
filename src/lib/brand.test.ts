import fs from "node:fs";
import path from "node:path";
import { createMcpHandler } from "mcp-handler";
import { describe, expect, it } from "vitest";
import { ICON_FILES, mcpIcons, mcpServerInfo } from "./brand";
import { VERSION } from "./config";
import { authorizationServerMetadata, protectedResourceMetadata } from "./oauth";

const BASE = "https://crossdrive.example.com";
const PUBLIC = path.resolve(__dirname, "..", "..", "public");

function pngSize(buf: Buffer): { w: number; h: number } {
  expect(buf.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

describe("MCP serverInfo", () => {
  it("advertises title, description, website and same-origin https icons with sizes and MIME types", () => {
    const info = mcpServerInfo(`${BASE}/`);
    expect(info).toMatchObject({ name: "crossdrive", title: "Crossdrive", version: VERSION, websiteUrl: `${BASE}/` });
    expect(info.description).toMatch(/MCP server/);
    expect(info.icons).toEqual([
      { src: `${BASE}/icon-48.png`, mimeType: "image/png", sizes: ["48x48"] },
      { src: `${BASE}/icon-192.png`, mimeType: "image/png", sizes: ["192x192"] },
      { src: `${BASE}/icon-512.png`, mimeType: "image/png", sizes: ["512x512"] },
      { src: `${BASE}/icon.svg`, mimeType: "image/svg+xml", sizes: ["any"] },
    ]);
    for (const icon of info.icons ?? []) expect(new URL(icon.src).origin).toBe(BASE);
  });

  it("omits icons when the base URL is not https (clients must reject other schemes)", () => {
    expect(mcpIcons("http://localhost:3000")).toEqual([]);
    const info = mcpServerInfo("http://localhost:3000");
    expect(info).not.toHaveProperty("icons");
    expect(info.websiteUrl).toBe("http://localhost:3000/");
  });

  it("returns the icons in the initialize result", async () => {
    const handler = createMcpHandler(() => {}, { serverInfo: mcpServerInfo(BASE) });
    const res = await handler(
      new Request(`${BASE}/api/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "0" } },
        }),
      }),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    const json = JSON.parse(text.includes("data:") ? text.split("\n").find((l) => l.startsWith("data:"))!.slice(5) : text);
    expect(json.result.serverInfo).toEqual(mcpServerInfo(BASE));
  });
});

describe("icon files", () => {
  it("exist in public/ with the advertised dimensions", () => {
    for (const f of Object.values(ICON_FILES)) {
      const buf = fs.readFileSync(path.join(PUBLIC, f.path));
      if (f.mimeType === "image/png") {
        const { w, h } = pngSize(buf);
        expect(f.sizes, f.path).toEqual([`${w}x${h}`]);
      } else if (f.mimeType === "image/svg+xml") {
        expect(buf.toString("utf8"), f.path).toMatch(/^<svg [^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
        expect(buf.toString("utf8"), f.path).not.toMatch(/<script|on\w+=/i);
      }
    }
  });

  it("favicon.ico is an ICO file (its entries are checked in scripts/lib/ico.test.mjs)", () => {
    const buf = fs.readFileSync(path.join(PUBLIC, ICON_FILES.ico.path));
    expect([buf.readUInt16LE(0), buf.readUInt16LE(2), buf.readUInt16LE(4)]).toEqual([0, 1, ICON_FILES.ico.sizes.length]);
  });

  it("the apple touch icon is opaque (iOS fills transparency with black)", () => {
    const buf = fs.readFileSync(path.join(PUBLIC, ICON_FILES.apple.path));
    expect(buf.readUInt8(25)).toBe(2); // IHDR colour type 2 = truecolour without alpha
  });
});

describe("well-known metadata", () => {
  it("links the privacy policy and terms using the fields RFC 8414 and RFC 9728 define", () => {
    process.env.VAULT_BASE_URL = BASE;
    expect(authorizationServerMetadata()).toMatchObject({ op_policy_uri: `${BASE}/privacy`, op_tos_uri: `${BASE}/terms` });
    expect(protectedResourceMetadata()).toMatchObject({
      resource_name: "Crossdrive",
      resource_policy_uri: `${BASE}/privacy`,
      resource_tos_uri: `${BASE}/terms`,
    });
  });
});
