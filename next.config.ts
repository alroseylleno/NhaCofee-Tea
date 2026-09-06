import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep dev compilation separate so it cannot erase assets used by `next start`.
  distDir: process.env.NODE_ENV === "development" ? ".next-dev" : ".next",
  // pdfjs ships its own worker/font loading; bundling it breaks the Node build
  // used by the local /api/grab-reports route.
  serverExternalPackages: ["pdfjs-dist"],
};

export default nextConfig;
