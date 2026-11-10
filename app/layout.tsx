import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { Space_Grotesk } from "next/font/google";
import { baseUrl } from "@/lib/config";
import "./ui.css";

const display = Space_Grotesk({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  variable: "--font-space-grotesk",
  display: "swap",
});

const GITHUB = "https://github.com/vivek-gelp/crossdrive";

export const metadata: Metadata = {
  metadataBase: new URL(baseUrl()),
  title: { default: "Crossdrive", template: "%s · Crossdrive" },
  description:
    "A self-hosted MCP server that gives your AI one safe connection to every Google Drive and Gmail account you own, plus OneDrive and Dropbox in beta.",
  openGraph: {
    title: "Crossdrive",
    description: "Every drive you own. One safe connection for your AI.",
    type: "website",
  },
  twitter: { card: "summary_large_image" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#F7F5F0" },
    { media: "(prefers-color-scheme: dark)", color: "#0E1116" },
  ],
};

function Mark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <rect x="4" y="4" width="36" height="36" rx="9" fill="var(--teal)" />
      <rect x="24" y="24" width="36" height="36" rx="9" fill="var(--amber)" />
      <path d="M33 24H40V31A9 9 0 0 1 31 40H24V33A9 9 0 0 1 33 24Z" fill="var(--overlap)" />
    </svg>
  );
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={display.variable}>
      <body>
        <header className="site-header">
          <Link href="/" className="brand" aria-label="crossdrive home">
            <Mark />
            <span>crossdrive</span>
          </Link>
          <nav className="nav" aria-label="Main">
            <Link href="/setup">Setup</Link>
            <Link href="/connect">Connect</Link>
            <a href={GITHUB} rel="noopener">
              GitHub
            </a>
          </nav>
        </header>
        <div className="site-main">{children}</div>
        <footer className="site-footer">
          <Link href="/privacy">Privacy</Link>
          <Link href="/terms">Terms</Link>
          <a href={`${GITHUB}/blob/main/LICENSE`} rel="noopener">
            MIT licence
          </a>
          <span>Open source, self-hosted.</span>
        </footer>
      </body>
    </html>
  );
}
