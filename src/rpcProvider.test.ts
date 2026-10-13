import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ethers } from 'ethers';
import {
  createRpcProvider,
  DEFAULT_POLYGON_RPC_URL,
  DEFAULT_POLYGON_RPC_FALLBACK_URL,
  extractRpcDiagnostic,
  getPolygonRpcUrl,
  getPolygonRpcFallbackUrls,
  isTransientRpcReadError,
  RPC_BATCH_MAX_COUNT,
  withRpcReadRetry,
  RPC_REQUEST_TIMEOUT_MS,
} from './rpcProvider';

type RpcStubReply = {
  result?: unknown;
  error?: { code: number; message?: string; data?: unknown };
  httpStatus?: number;
  hang?: boolean;
  close?: boolean;
  delayMs?: number;
  rawBody?: string;
};

type RpcStub = {
  url: string;
  calls: Array<{ method: string; params: unknown[]; body: unknown }>;
  close: () => Promise<void>;
};

async function startRpcStub(
  handler: (method: string, params: unknown[], body: Record<string, unknown>) => RpcStubReply | Promise<RpcStubReply>,
): Promise<RpcStub> {
  const calls: RpcStub['calls'] = [];
  const sockets = new Set<import('node:net').Socket>();
  const server = http.createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    request.on('end', async () => {
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      } catch {
        response.statusCode = 400;
        response.end('bad request');
        return;
      }
      const method = String(body.method || '');
      const params = Array.isArray(body.params) ? body.params : [];
      calls.push({ method, params, body });
      const reply = await handler(method, params, body);
      if (reply.hang) return;
      if (reply.close) {
        response.destroy();
        return;
      }
      if (reply.delayMs) await new Promise(resolve => setTimeout(resolve, reply.delayMs));
      if (reply.rawBody !== undefined) {
        response.statusCode = reply.httpStatus || 200;
        response.setHeader('content-type', 'application/json');
        response.end(reply.rawBody);
        return;
      }
      const payload = {
        jsonrpc: '2.0',
        id: body.id,
        ...(reply.error ? { error: reply.error } : { result: reply.result }),
      };
      response.statusCode = reply.httpStatus || 200;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(payload));
    });
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    calls,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
      });
    },
  };
}

const AMOY_CHAIN_ID = '0x13882';
const TEST_HASH = `0x${'ab'.repeat(32)}`;
const TEST_PRIVATE_KEY = `0x${'11'.repeat(32)}`;

function chainReply(): RpcStubReply {
  return { result: AMOY_CHAIN_ID };
}

describe('rpc provider construction', () => {
  const configuredUrl = process.env.POLYGON_RPC_URL;
  const configuredFallback = process.env.POLYGON_RPC_FALLBACK_URL;
  const configuredFallbacks = process.env.POLYGON_RPC_FALLBACK_URLS;
  const configuredChainId = process.env.CHAIN_ID;

  afterEach(() => {
    if (configuredUrl === undefined) delete process.env.POLYGON_RPC_URL;
    else process.env.POLYGON_RPC_URL = configuredUrl;
    if (configuredFallback === undefined) delete process.env.POLYGON_RPC_FALLBACK_URL;
    else process.env.POLYGON_RPC_FALLBACK_URL = configuredFallback;
    if (configuredFallbacks === undefined) delete process.env.POLYGON_RPC_FALLBACK_URLS;
    else process.env.POLYGON_RPC_FALLBACK_URLS = configuredFallbacks;
    if (configuredChainId === undefined) delete process.env.CHAIN_ID;
    else process.env.CHAIN_ID = configuredChainId;
  });

  it('disables batching and bounds each transport request while retaining configured chain validation', () => {
    const provider = createRpcProvider('https://example.invalid/polygon');
    const connection = provider._getConnection();

    expect(provider._getOption('batchMaxCount')).toBe(RPC_BATCH_MAX_COUNT);
    expect(provider._getOption('staticNetwork')).toMatchObject({ chainId: 80002n });
    expect(connection.timeout).toBe(RPC_REQUEST_TIMEOUT_MS);
    expect(RPC_REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(15_000);
    expect(connection.url).toBe('https://example.invalid/polygon');
  });

  it('keeps the existing environment endpoint and default fallback', () => {
    process.env.POLYGON_RPC_URL = 'https://configured.invalid/rpc';
    expect(getPolygonRpcUrl()).toBe('https://configured.invalid/rpc');

    delete process.env.POLYGON_RPC_URL;
    expect(getPolygonRpcUrl()).toBe(DEFAULT_POLYGON_RPC_URL);
    delete process.env.POLYGON_RPC_FALLBACK_URL;
    delete process.env.POLYGON_RPC_FALLBACK_URLS;
    expect(getPolygonRpcFallbackUrls()).toEqual([DEFAULT_POLYGON_RPC_FALLBACK_URL]);
    expect(getPolygonRpcFallbackUrls(`${DEFAULT_POLYGON_RPC_URL}/`)).toEqual([DEFAULT_POLYGON_RPC_FALLBACK_URL]);
    expect(getPolygonRpcFallbackUrls('HTTPS://POLYGON-AMOY.DRPC.ORG')).toEqual([DEFAULT_POLYGON_RPC_FALLBACK_URL]);

    process.env.POLYGON_RPC_FALLBACK_URLS = 'https://fallback-a.invalid, https://fallback-b.invalid';
    expect(getPolygonRpcFallbackUrls('https://custom.invalid/rpc')).toEqual(['https://fallback-a.invalid']);
  });

  it('recovers nested dRPC read failures without retrying deterministic errors', async () => {
    const read = jest.fn()
      .mockRejectedValueOnce({ code: 'UNKNOWN_ERROR', error: { code: 26, message: 'Unknown block' } })
      .mockRejectedValueOnce({ code: 'UNKNOWN_ERROR', error: { code: 30, message: 'Request timeout' } })
      .mockResolvedValueOnce('receipt');

    await expect(withRpcReadRetry(read, { delayMs: 0 })).resolves.toBe('receipt');
    expect(read).toHaveBeenCalledTimes(3);

    const deterministic = jest.fn().mockRejectedValue({ code: 'CALL_EXCEPTION', message: 'execution reverted' });
    await expect(withRpcReadRetry(deterministic, { delayMs: 0 })).rejects.toMatchObject({ code: 'CALL_EXCEPTION' });
    expect(deterministic).toHaveBeenCalledTimes(1);
  });

  it('caps a retry budget even when a provider repeatedly fails', async () => {
    const read = jest.fn().mockRejectedValue({ code: 30, message: 'Request timeout' });

    await expect(withRpcReadRetry(read, { maxAttempts: 20, delayMs: 0 })).rejects.toMatchObject({ code: 30 });
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('keeps transient classification safe for circular provider wrappers', () => {
    const circular: Record<string, unknown> = { message: 'request timeout' };
    circular.self = circular;

    expect(isTransientRpcReadError(circular)).toBe(true);
  });

  it('extracts bounded dRPC responseBody fields from the production ethers wrapper', () => {
    const details = extractRpcDiagnostic({
      code: 'SERVER_ERROR',
      info: {
        responseStatus: '500 Internal Server Error',
        responseBody: JSON.stringify({
          id: 108,
          jsonrpc: '2.0',
          error: {
            code: 19,
            message: 'Temporary internal error. Please retry, trace-id: e8109f4bb0bbf568daa9f3f080df5df6',
          },
        }),
      },
    });
    expect(details).toEqual({
      providerCode: 'SERVER_ERROR',
      rpcCode: 19,
      httpStatus: 500,
      traceId: 'e8109f4bb0bbf568daa9f3f080df5df6',
    });
    expect(isTransientRpcReadError({
      code: 'SERVER_ERROR',
      info: { responseStatus: '500 Internal Server Error', responseBody: JSON.stringify({ error: { code: 19 } }) },
    })).toBe(true);
  });

  it('bounds a provider read even when the SDK promise never settles', async () => {
    const read = jest.fn(() => new Promise<string>(() => undefined));
    await expect(withRpcReadRetry(read, { maxAttempts: 1, delayMs: 0, timeoutMs: 5 }))
      .rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('uses a real sequential fallback when the primary transport is unavailable', async () => {
    const fallback = await startRpcStub(async method => {
      if (method === 'eth_chainId') return chainReply();
      if (method === 'eth_blockNumber') return { result: '0x2f9aa95' };
      return { result: null };
    });
    const primary = await startRpcStub(async () => ({ close: true }));
    try {
      const provider = createRpcProvider(primary.url, [fallback.url], 80002, 150);
      await expect(provider.getBlockNumber()).resolves.toBe(0x2f9aa95);
      expect(primary.calls.map(call => call.method)).toContain('eth_chainId');
      expect(fallback.calls.map(call => call.method)).toEqual(expect.arrayContaining(['eth_chainId', 'eth_blockNumber']));
      expect(provider.getLastRpcFailoverEvidence()).toEqual(expect.arrayContaining([
        expect.objectContaining({ label: 'primary', outcome: 'failed' }),
        expect.objectContaining({ label: 'fallback-1', outcome: 'success' }),
      ]));
    } finally {
      await primary.close();
      await fallback.close();
    }
  });

  it('abandons a hung primary within the bounded endpoint budget and reaches fallback', async () => {
    const primary = await startRpcStub(async () => ({ hang: true }));
    const fallback = await startRpcStub(async method => {
      if (method === 'eth_chainId') return chainReply();
      if (method === 'eth_blockNumber') return { result: '0x2f9aa96' };
      return { result: null };
    });
    try {
      const provider = createRpcProvider(primary.url, [fallback.url], 80002, 120);
      const started = Date.now();
      await expect(provider.getBlockNumber()).resolves.toBe(0x2f9aa96);
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(fallback.calls.map(call => call.method)).toEqual(expect.arrayContaining(['eth_chainId', 'eth_blockNumber']));
    } finally {
      await primary.close();
      await fallback.close();
    }
  });

  it('fails over an actual dRPC-style HTTP 400 unknown-block response', async () => {
    const primary = await startRpcStub(async method => {
      if (method === 'eth_chainId') return chainReply();
      if (method === 'eth_blockNumber') return {
        httpStatus: 400,
        error: { code: 26, message: 'Unknown block' },
      };
      return { result: null };
    });
    const fallback = await startRpcStub(async method => {
      if (method === 'eth_chainId') return chainReply();
      if (method === 'eth_blockNumber') return { result: '0x2f9aa97' };
      return { result: null };
    });
    try {
      const provider = createRpcProvider(primary.url, [fallback.url], 80002, 120);
      await expect(provider.getBlockNumber()).resolves.toBe(0x2f9aa97);
      expect(fallback.calls.map(call => call.method)).toContain('eth_blockNumber');
    } finally {
      await primary.close();
      await fallback.close();
    }
  });

  it('fails over a malformed HTTP 200 envelope and rejects when both are malformed', async () => {
    const primary = await startRpcStub(async method => {
      if (method === 'eth_chainId') return chainReply();
      if (method === 'eth_blockNumber') return { rawBody: JSON.stringify({ jsonrpc: '2.0', id: 999, result: '0x1' }) };
      return { result: null };
    });
    const fallback = await startRpcStub(async method => {
      if (method === 'eth_chainId') return chainReply();
      if (method === 'eth_blockNumber') return { result: '0x2f9aa99' };
      return { result: null };
    });
    const malformedFallback = await startRpcStub(async method => {
      if (method === 'eth_chainId') return chainReply();
      if (method === 'eth_blockNumber') return { rawBody: JSON.stringify({ jsonrpc: '2.0', result: '0x1' }) };
      return { result: null };
    });
    try {
      const provider = createRpcProvider(primary.url, [fallback.url], 80002, 120);
      await expect(provider.getBlockNumber()).resolves.toBe(0x2f9aa99);

      const bothMalformed = createRpcProvider(primary.url, [malformedFallback.url], 80002, 120);
      await expect(bothMalformed.getBlockNumber()).rejects.toMatchObject({ code: 'RPC_MALFORMED_RESPONSE' });
      expect(bothMalformed.getLastRpcFailoverEvidence()).toEqual(expect.arrayContaining([
        expect.objectContaining({ label: 'primary', outcome: 'failed' }),
        expect.objectContaining({ label: 'fallback-1', outcome: 'failed' }),
      ]));
    } finally {
      await primary.close();
      await fallback.close();
      await malformedFallback.close();
    }
  });

  it('fails within the bounded combined budget when both endpoints are unavailable', async () => {
    const primary = await startRpcStub(async () => ({ close: true }));
    const fallback = await startRpcStub(async () => ({ close: true }));
    try {
      const provider = createRpcProvider(primary.url, [fallback.url], 80002, 120);
      const started = Date.now();
      let failure: unknown;
      try {
        await provider.getBlockNumber();
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeDefined();
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(provider.getLastRpcFailoverEvidence()).toHaveLength(2);
      const diagnostic = extractRpcDiagnostic(failure);
      expect(diagnostic).toEqual(expect.objectContaining({ failover: expect.any(Array) }));
    } finally {
      await primary.close();
      await fallback.close();
    }
  });

  it('deduplicates equivalent endpoint URLs and does not disable the default slash variant', async () => {
    const primary = await startRpcStub(async () => ({ close: true }));
    try {
      const provider = createRpcProvider(primary.url, [`${primary.url}/`, primary.url.toUpperCase()], 80002, 120);
      await expect(provider.getBlockNumber()).rejects.toBeDefined();
      expect(provider.getLastRpcFailoverEvidence()).toHaveLength(1);
    } finally {
      await primary.close();
    }
  });

  it('rejects a fallback on the wrong chain before attempting the read', async () => {
    const primary = await startRpcStub(async () => ({ close: true }));
    const fallback = await startRpcStub(async method => method === 'eth_chainId' ? { result: '0x89' } : { result: '0x1' });
    try {
      const provider = createRpcProvider(primary.url, [fallback.url], 80002, 120);
      await expect(provider.getBlockNumber()).rejects.toMatchObject({ code: 'CHAIN_ID_MISMATCH' });
      expect(fallback.calls.map(call => call.method)).toEqual(['eth_chainId']);
    } finally {
      await primary.close();
      await fallback.close();
    }
  });

  it('skips a wrong-chain primary and accepts a same-chain fallback', async () => {
    const primary = await startRpcStub(async method => method === 'eth_chainId' ? { result: '0x89' } : { result: '0x1' });
    const fallback = await startRpcStub(async method => {
      if (method === 'eth_chainId') return chainReply();
      if (method === 'eth_blockNumber') return { result: '0x2f9aa98' };
      return { result: null };
    });
    try {
      const provider = createRpcProvider(primary.url, [fallback.url], 80002, 120);
      await expect(provider.getBlockNumber()).resolves.toBe(0x2f9aa98);
      expect(primary.calls.map(call => call.method)).toEqual(['eth_chainId']);
      expect(fallback.calls.map(call => call.method)).toEqual(expect.arrayContaining(['eth_chainId', 'eth_blockNumber']));
    } finally {
      await primary.close();
      await fallback.close();
    }
  });

  it('preserves a deterministic revert and does not fail over it', async () => {
    const primary = await startRpcStub(async method => {
      if (method === 'eth_chainId') return chainReply();
      if (method === 'eth_estimateGas') return { error: { code: 3, message: 'execution reverted' } };
      return { result: '0x1' };
    });
    const fallback = await startRpcStub(async method => {
      if (method === 'eth_chainId') return chainReply();
      return { result: '0x1' };
    });
    try {
      const provider = createRpcProvider(primary.url, [fallback.url], 80002, 120);
      await expect(provider.estimateGas({ to: ethers.ZeroAddress })).rejects.toMatchObject({ code: 'CALL_EXCEPTION' });
      expect(primary.calls.map(call => call.method)).toContain('eth_estimateGas');
      expect(fallback.calls.map(call => call.method)).not.toContain('eth_estimateGas');
      expect(isTransientRpcReadError({ code: 3, message: 'execution reverted' })).toBe(false);
    } finally {
      await primary.close();
      await fallback.close();
    }
  });

  it('uses a mined receipt from fallback after primary reports null', async () => {
    const primary = await startRpcStub(async method => {
      if (method === 'eth_chainId') return chainReply();
      if (method === 'eth_getTransactionReceipt') return { result: null };
      return { result: null };
    });
    const fallback = await startRpcStub(async method => {
      if (method === 'eth_chainId') return chainReply();
      if (method === 'eth_getTransactionReceipt') return { result: {
        transactionHash: TEST_HASH,
        blockHash: `0x${'cd'.repeat(32)}`,
        blockNumber: '0x2f9aa95',
        status: '0x1',
      } };
      return { result: null };
    });
    try {
      const provider = createRpcProvider(primary.url, [fallback.url], 80002, 120);
      const receipt = await provider.send('eth_getTransactionReceipt', [TEST_HASH]);
      expect(receipt).toMatchObject({ transactionHash: TEST_HASH, status: '0x1' });
      expect(primary.calls.map(call => call.method)).toContain('eth_getTransactionReceipt');
      expect(fallback.calls.map(call => call.method)).toContain('eth_getTransactionReceipt');
      expect(provider.getLastRpcFailoverEvidence()).toEqual(expect.arrayContaining([
        expect.objectContaining({ label: 'primary', outcome: 'null' }),
        expect.objectContaining({ label: 'fallback-1', outcome: 'success' }),
      ]));
    } finally {
      await primary.close();
      await fallback.close();
    }
  });

  it('replays the exact signed bytes on a lost primary send response', async () => {
    const primaryRaw: string[] = [];
    const fallbackRaw: string[] = [];
    const primary = await startRpcStub(async (method, params) => {
      if (method === 'eth_chainId') return chainReply();
      if (method === 'eth_sendRawTransaction') {
        primaryRaw.push(String(params[0]));
        return { close: true };
      }
      return { result: '0x1' };
    });
    const fallback = await startRpcStub(async (method, params) => {
      if (method === 'eth_chainId') return chainReply();
      if (method === 'eth_sendRawTransaction') {
        fallbackRaw.push(String(params[0]));
        return { result: ethers.keccak256(String(params[0])) };
      }
      return { result: '0x1' };
    });
    try {
      const wallet = new ethers.Wallet(TEST_PRIVATE_KEY);
      const raw = await wallet.signTransaction({
        chainId: 80002,
        nonce: 17,
        to: ethers.ZeroAddress,
        value: 0,
        gasLimit: 21_000,
        gasPrice: 1_000_000_000,
      });
      const expectedHash = ethers.keccak256(raw);
      const provider = createRpcProvider(primary.url, [fallback.url], 80002, 120);
      const broadcast = await provider.broadcastTransaction(raw);
      expect(broadcast.hash).toBe(expectedHash);
      expect(primaryRaw).toEqual([raw]);
      expect(fallbackRaw).toEqual([raw]);
      expect(new Set([...primaryRaw, ...fallbackRaw].map(value => ethers.keccak256(value)))).toEqual(new Set([expectedHash]));
    } finally {
      await primary.close();
      await fallback.close();
    }
  });

  it('does not replay provider-managed eth_sendTransaction without signed bytes', async () => {
    const primary = await startRpcStub(async method => {
      if (method === 'eth_chainId') return chainReply();
      if (method === 'eth_sendTransaction') return {
        error: { code: 19, message: 'Temporary internal error' },
      };
      return { result: '0x1' };
    });
    const fallback = await startRpcStub(async method => {
      if (method === 'eth_chainId') return chainReply();
      return { result: '0x1234' };
    });
    try {
      const provider = createRpcProvider(primary.url, [fallback.url], 80002, 120);
      await expect(provider.send('eth_sendTransaction', [{
        from: ethers.ZeroAddress,
        to: ethers.ZeroAddress,
        value: '0x0',
      }])).rejects.toBeDefined();
      expect(primary.calls.map(call => call.method)).toContain('eth_sendTransaction');
      expect(fallback.calls.map(call => call.method)).not.toContain('eth_sendTransaction');
    } finally {
      await primary.close();
      await fallback.close();
    }
  });
});
