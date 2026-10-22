import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Next 16.4 currently fails to parse `tsc --showConfig` under Node 24.
  // CI runs `npm run typecheck` separately until the upstream issue is fixed.
  typescript: {
    ignoreBuildErrors: true,
  },
};

export default nextConfig;
