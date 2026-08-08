import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep dev compilation separate so it cannot erase assets used by `next start`.
  distDir: process.env.NODE_ENV === "development" ? ".next-dev" : ".next",
};

export default nextConfig;
