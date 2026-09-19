import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Local upload uses this origin; Next dev otherwise blocks its HMR/debug channel.
  allowedDevOrigins: ["127.0.0.1"],
};

export default nextConfig;
