import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      bodySizeLimit: '25mb',
    },
  },
  // Ensure the brand logo PNG is traced into the report-export serverless
  // function bundle on Netlify. public/ assets are CDN-served and not bundled
  // into functions by default, so the pdf-lib logo read from process.cwd()
  // would otherwise fall back to the text wordmark in production.
  outputFileTracingIncludes: {
    '/api/admin/reports/export': ['./public/brand/black.png'],
    '/api/brokerage/reports/export': ['./public/brand/black.png'],
    '/api/agent/reports/export': ['./public/brand/black.png'],
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
          {
            key: 'X-Content-Type-Options',
            value: 'nosniff',
          },
          {
            key: 'X-Frame-Options',
            value: 'DENY',
          },
          {
            key: 'Referrer-Policy',
            value: 'strict-origin-when-cross-origin',
          },
          {
            // camera=(self): our own origin may use getUserMedia for in-browser
            // ID capture (the KYC camera defaults to the rear camera). Still
            // denied to third-party iframes and other features stay off.
            key: 'Permissions-Policy',
            value: 'camera=(self), microphone=(), geolocation=(), payment=()',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
