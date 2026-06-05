import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // The workspace packages ship raw TypeScript, so Next must transpile them.
  transpilePackages: ['@approvals-mcp/core', '@approvals-mcp/db'],
  // The DB drivers load native/WASM assets via runtime paths that break when
  // bundled, so keep them as external node requires.
  serverExternalPackages: ['@electric-sql/pglite', 'postgres'],
};

export default nextConfig;
