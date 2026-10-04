import path from 'node:path';
import type { NextConfig } from 'next';
import { buildSecurityHeaders } from './src/lib/security-headers';

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  outputFileTracingRoot: path.join(import.meta.dirname, '../..'),
  async headers() {
    return [{ source: '/:path*', headers: [...buildSecurityHeaders(process.env.NODE_ENV)] }];
  },
};

export default nextConfig;
