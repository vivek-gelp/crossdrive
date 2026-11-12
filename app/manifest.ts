import type { MetadataRoute } from "next";
import { DESCRIPTION, ICON_FILES, NAME } from "@/lib/brand";

// Served at /manifest.webmanifest, linked from every page by Next. Gives the 192 and 512 px icons a standard home.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: NAME,
    short_name: NAME,
    description: DESCRIPTION,
    start_url: "/",
    display: "browser",
    background_color: "#F7F5F0",
    theme_color: "#F7F5F0",
    icons: [ICON_FILES.png192, ICON_FILES.png512, ICON_FILES.svg].map((f) => ({
      src: f.path,
      type: f.mimeType,
      sizes: f.sizes.join(" "),
    })),
  };
}
