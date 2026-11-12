import type { NextConfig } from "next";

// Baseline browser hardening for every route. Routes that set a stricter policy themselves (the OAuth consent
// page) keep theirs; these are the floor.
const SECURITY_HEADERS = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  // Heavy parsers stay external so Node loads them as published; unpdf's pdf.js build needs no browser globals.
  serverExternalPackages: ["unpdf", "mammoth", "xlsx"],
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
};

export default nextConfig;
