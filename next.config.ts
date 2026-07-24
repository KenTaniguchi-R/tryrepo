import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Served publicly through a Cloudflare tunnel during the demo. Next dev
  // rejects cross-origin dev requests (HMR websocket, /_next assets) from a
  // non-localhost origin, which leaves the page server-rendered but never
  // hydrated -- the UI looks fine and nothing is clickable.
  allowedDevOrigins: ["tryrepo.benree.tech"],
};

export default nextConfig;
