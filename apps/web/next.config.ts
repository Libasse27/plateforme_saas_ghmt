import path from 'node:path';
import type { NextConfig } from 'next';
import { buildSecurityHeaders } from './src/lib/security-headers';

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  // Dépôt des documents par action serveur (docs/13 D3) : 10 Mo de fichier + en-têtes multipart.
  experimental: { serverActions: { bodySizeLimit: '11mb' }, proxyClientMaxBodySize: '11mb' },
  outputFileTracingRoot: path.join(import.meta.dirname, '../..'),
  async headers() {
    return [{ source: '/:path*', headers: [...buildSecurityHeaders(process.env.NODE_ENV)] }];
  },
};

export default nextConfig;
