import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      bodySizeLimit: '25mb',
    },
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
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), payment=()',
          },
          {
            // Content Security Policy: defense-in-depth against XSS.
            //
            // script-src includes 'unsafe-inline' for two reasons:
            //   1. Next.js 16's hydration scripts are inline and the framework
            //      does not currently emit them with predictable hashes that
            //      would let us use 'strict-dynamic' + hash allowlist.
            //   2. Switching to nonce-based CSP requires middleware to set a
            //      fresh nonce on every request, which forces every page to
            //      render dynamically — killing static optimization for ~26
            //      of 41 routes. That was attempted in session 6 and reverted
            //      after the perf regression showed up in the build output.
            //
            // Defer hardening this until: (a) we have a measurable XSS attack
            // surface that's not already mitigated by the email-escape /
            // server-action ownership checks shipped in sessions 8–9, and
            // (b) we can afford the static→dynamic perf hit (Netlify edge
            // cache helps but TTFB increases). Track as a follow-up.
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://maps.googleapis.com https://maps.gstatic.com",
              "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
              "img-src 'self' data: blob: https://*.supabase.co https://maps.gstatic.com https://maps.googleapis.com https://*.googleusercontent.com",
              "font-src 'self' https://fonts.gstatic.com",
              "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://*.upstash.io https://maps.googleapis.com https://places.googleapis.com",
              "worker-src 'self' blob: https://cdnjs.cloudflare.com",
              "object-src 'none'",
              "frame-ancestors 'none'",
              "base-uri 'self'",
              "form-action 'self'",
              "upgrade-insecure-requests",
            ].join('; '),
          },
          {
            key: 'Access-Control-Allow-Origin',
            value: 'https://firmfunds.ca',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
