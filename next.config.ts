import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  reactCompiler: true,
  // firebase-admin pulls in jwks-rsa which requires jose via CJS require().
  // jose v5+ is ESM-only → require() fails. Mark all three as external so
  // Turbopack lets Node.js load them natively instead of bundling them.
  serverExternalPackages: [
    "firebase-admin",
    "firebase-admin/auth",
    "firebase-admin/firestore",
    "firebase-admin/messaging",
    "jwks-rsa",
    "jose",
  ],
  async headers() {
    return [
      {
        source: "/api/:path*",
        headers: [
          { key: "Access-Control-Allow-Credentials", value: "true" },
          { key: "Access-Control-Allow-Origin", value: "*" }, // Can be restricted to specific domains
          { key: "Access-Control-Allow-Methods", value: "GET,OPTIONS,PATCH,DELETE,POST,PUT" },
          { key: "Access-Control-Allow-Headers", value: "X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization" },
        ]
      }
    ];
  }
};

export default nextConfig;
