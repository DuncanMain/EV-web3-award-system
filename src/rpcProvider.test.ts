import {
  createRpcProvider,
  DEFAULT_POLYGON_RPC_URL,
  getPolygonRpcUrl,
  isTransientRpcReadError,
  RPC_BATCH_MAX_COUNT,
  withRpcReadRetry,
  RPC_REQUEST_TIMEOUT_MS,
} from './rpcProvider';

describe('rpc provider construction', () => {
  const configuredUrl = process.env.POLYGON_RPC_URL;

  afterEach(() => {
    if (configuredUrl === undefined) delete process.env.POLYGON_RPC_URL;
    else process.env.POLYGON_RPC_URL = configuredUrl;
  });

  it('disables batching and bounds each transport request without static network bypass', () => {
    const provider = createRpcProvider('https://example.invalid/polygon');
    const connection = provider._getConnection();

    expect(provider._getOption('batchMaxCount')).toBe(RPC_BATCH_MAX_COUNT);
    expect(provider._getOption('staticNetwork')).toBeNull();
    expect(connection.timeout).toBe(RPC_REQUEST_TIMEOUT_MS);
    expect(RPC_REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(15_000);
    expect(connection.url).toBe('https://example.invalid/polygon');
  });

  it('keeps the existing environment endpoint and default fallback', () => {
    process.env.POLYGON_RPC_URL = 'https://configured.invalid/rpc';
    expect(getPolygonRpcUrl()).toBe('https://configured.invalid/rpc');

    delete process.env.POLYGON_RPC_URL;
    expect(getPolygonRpcUrl()).toBe(DEFAULT_POLYGON_RPC_URL);
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
});
