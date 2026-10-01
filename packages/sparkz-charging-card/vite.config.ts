import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const demoApiOrigin = process.env.NVF_DEMO_API_ORIGIN || 'http://127.0.0.1:3005';
const demoApiKey = process.env.NVF_DEMO_API_KEY || '';
const demoEmaid = process.env.NVF_DEMO_EMAID || '';
const demoProxyPrefix = '/api/sparkz';

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}

function validateLoopbackOrigin(origin: string): void {
  const parsed = new URL(origin);
  if (!['http:', 'https:'].includes(parsed.protocol)
    || !isLoopbackHost(parsed.hostname)
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || (parsed.pathname !== '/' && parsed.pathname !== '')) {
    throw new Error('NVF_DEMO_API_ORIGIN must be a loopback HTTP(S) origin without credentials or a path');
  }
}

function decodePathPart(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value);
    return decoded.includes('/') ? null : decoded;
  } catch {
    return null;
  }
}

function isAllowedDemoRoute(method: string, upstreamPath: string, configuredEmaid: string): boolean {
  if (method === 'GET' && upstreamPath === '/wallet/me') return true;
  if (method === 'POST' && ['/spend/session', '/spend/me', '/spend/reservation-approval-intent'].includes(upstreamPath)) return true;
  if (method === 'GET' && /^\/spend\/reservations\/[^/]+$/.test(upstreamPath)) {
    return decodePathPart(upstreamPath.slice('/spend/reservations/'.length)) !== null;
  }

  const walletRoute = upstreamPath.match(/^\/wallet\/([^/]+)\/(linked-wallets|mode)$/);
  if (method === 'POST' && walletRoute) {
    const owner = decodePathPart(walletRoute[1]);
    return owner !== null && owner !== 'me' && owner === configuredEmaid;
  }
  return false;
}

function stripAndBindHeaders(headers: Record<string, string | string[] | undefined>): void {
  delete headers.authorization;
  delete headers.cookie;
  delete headers['x-api-key'];
  delete headers['x-ingest-api-key'];
  delete headers['x-contract-id'];
  delete headers['x-uid'];
  delete headers['x-emaid'];
  if (demoApiKey) headers['x-api-key'] = demoApiKey;
  if (demoEmaid) headers['x-contract-id'] = demoEmaid;
}

function upstreamPathFor(requestUrl: string): string {
  const parsed = new URL(requestUrl, 'http://127.0.0.1');
  return parsed.pathname.startsWith(`${demoProxyPrefix}/`)
    ? parsed.pathname.slice(demoProxyPrefix.length) || '/'
    : parsed.pathname === demoProxyPrefix ? '/' : parsed.pathname;
}

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'nvf-demo-proxy-guard',
      configureServer() {
        validateLoopbackOrigin(demoApiOrigin);
      },
    },
  ],
  server: {
    port: 3002,
    proxy: {
      [demoProxyPrefix]: {
        target: demoApiOrigin,
        changeOrigin: false,
        rewrite: path => path.replace(new RegExp(`^${demoProxyPrefix}`), '') || '/',
        bypass(request, response) {
          const upstreamPath = upstreamPathFor(request.url || '/');
          if (request.method === 'GET' && upstreamPath === '/demo-config') {
            if (!demoApiKey || !demoEmaid) {
              response?.writeHead(503, { 'content-type': 'application/json' });
              response?.end(JSON.stringify({ status: 'error', code: 'demo_proxy_configuration_required' }));
            } else {
              response?.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
              response?.end(JSON.stringify({ emaid: demoEmaid }));
            }
            return request.url || '/';
          }
          if (!demoApiKey || !demoEmaid) {
            response?.writeHead(503, { 'content-type': 'application/json' });
            response?.end(JSON.stringify({ status: 'error', code: 'demo_proxy_configuration_required' }));
            return request.url || '/';
          }
          if (!isAllowedDemoRoute(request.method || 'GET', upstreamPath, demoEmaid)) {
            response?.writeHead(404, { 'content-type': 'application/json' });
            response?.end(JSON.stringify({ status: 'error', code: 'demo_route_not_allowed' }));
            return request.url || '/';
          }
          stripAndBindHeaders(request.headers);
          return undefined;
        },
        configure(proxy) {
          proxy.on('proxyReq', (proxyReq, request) => {
            // Repeat the binding at the proxy boundary in case another
            // middleware has added caller-controlled credential headers.
            for (const header of ['authorization', 'cookie', 'x-api-key', 'x-ingest-api-key', 'x-contract-id', 'x-uid', 'x-emaid']) {
              proxyReq.removeHeader(header);
            }
            proxyReq.setHeader('x-api-key', demoApiKey);
            proxyReq.setHeader('x-contract-id', demoEmaid);
          });
        },
      },
    },
  },
  build: {
    lib: {
      entry: 'src/index.ts',
      name: 'SparkzChargingCard',
      fileName: 'sparkz-charging-card',
      formats: ['es', 'umd'],
    },
    rollupOptions: {
      external: ['react', 'react-dom', 'react/jsx-runtime'],
      output: {
        globals: {
          react: 'React',
          'react-dom': 'ReactDOM',
          'react/jsx-runtime': 'jsxRuntime',
        },
      },
    },
    cssCodeSplit: false,
  },
});
