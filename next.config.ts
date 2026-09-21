import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // T-008 build otherwise resolves unavailable native binaries for other OSes.
  // Node loads the installed platform binding; the package must ship with deployment.
  serverExternalPackages: ["@duckdb/node-api"],
  // Local upload uses this origin; Next dev otherwise blocks its HMR/debug channel.
  allowedDevOrigins: ["127.0.0.1"],
};

export default nextConfig;
