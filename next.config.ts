import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Heavy parsers stay external so Node loads them as published; unpdf's pdf.js build needs no browser globals.
  serverExternalPackages: ["unpdf", "mammoth", "xlsx"],
};

export default nextConfig;
