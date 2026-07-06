require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');

const BASE_URL = process.env.EVIDENCE_BASE_URL || process.env.API_BASE_URL || 'http://localhost:3000';
const INGEST_API_KEY = process.env.INGEST_API_KEY || process.env.API_KEY || '';
const TARGET_RPS = Number(process.env.LOAD_TEST_RPS || 10);
const DURATION_SECONDS = Number(process.env.LOAD_TEST_DURATION_SECONDS || 10);
const CONCURRENCY = Number(process.env.LOAD_TEST_CONCURRENCY || Math.max(1, Math.ceil(TARGET_RPS / 2)));

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function buildCdr(index) {
  const start = new Date(Date.UTC(2026, 6, 5, 23, 0, 0, 0));
  start.setSeconds(start.getSeconds() + index);
  const end = new Date(start);
  end.setMinutes(end.getMinutes() + 30);

  return {
    SessionID: `load-preview-${Date.now()}-${index}`,
    ProviderID: 'trl7-load-preview',
    EVSEID: 'DE*NVF*LOAD01',
    cdr_token: { contract_id: `load-contract-${index % 50}` },
    StartTime: start.toISOString(),
    EndTime: end.toISOString(),
    Energy: '12.5',
    EnergyDirection: 'CHARGE',
  };
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return Number(sorted[idx].toFixed(2));
}

async function postPreview(index) {
  const started = performance.now();
  try {
    const res = await fetch(`${BASE_URL}/ingest/cdr/preview`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(INGEST_API_KEY ? { 'X-Ingest-API-Key': INGEST_API_KEY } : {}),
      },
      body: JSON.stringify(buildCdr(index)),
    });
    const text = await res.text();
    const latencyMs = performance.now() - started;
    return {
      ok: res.ok,
      status: res.status,
      latencyMs,
      bodyPreview: text.slice(0, 500),
    };
  } catch (err) {
    return {
      ok: false,
      status: null,
      latencyMs: performance.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function main() {
  if (!Number.isFinite(TARGET_RPS) || TARGET_RPS <= 0) {
    throw new Error('LOAD_TEST_RPS must be a positive number');
  }
  if (!Number.isFinite(DURATION_SECONDS) || DURATION_SECONDS <= 0) {
    throw new Error('LOAD_TEST_DURATION_SECONDS must be a positive number');
  }

  const totalRequests = Math.floor(TARGET_RPS * DURATION_SECONDS);
  const intervalMs = 1000 / TARGET_RPS;
  const inFlight = new Set();
  const results = [];
  const startedAt = new Date();

  for (let i = 0; i < totalRequests; i += 1) {
    while (inFlight.size >= CONCURRENCY) {
      await Promise.race(inFlight);
    }

    const promise = postPreview(i)
      .then(result => results.push(result))
      .finally(() => inFlight.delete(promise));
    inFlight.add(promise);

    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }

  await Promise.all(inFlight);

  const completedAt = new Date();
  const latencies = results.map(result => result.latencyMs);
  const successful = results.filter(result => result.ok).length;
  const failed = results.length - successful;
  const elapsedSeconds = (completedAt.getTime() - startedAt.getTime()) / 1000;
  const evidence = {
    generatedAt: completedAt.toISOString(),
    baseUrl: BASE_URL,
    endpoint: '/ingest/cdr/preview',
    sideEffects: false,
    targetRps: TARGET_RPS,
    durationSeconds: DURATION_SECONDS,
    concurrency: CONCURRENCY,
    totalRequests: results.length,
    successful,
    failed,
    observedRps: Number((results.length / elapsedSeconds).toFixed(2)),
    latencyMs: {
      min: latencies.length ? Number(Math.min(...latencies).toFixed(2)) : null,
      avg: latencies.length ? Number((latencies.reduce((sum, value) => sum + value, 0) / latencies.length).toFixed(2)) : null,
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      max: latencies.length ? Number(Math.max(...latencies).toFixed(2)) : null,
    },
    failures: results
      .filter(result => !result.ok)
      .slice(0, 10)
      .map(result => ({
        status: result.status,
        latencyMs: Number(result.latencyMs.toFixed(2)),
        error: result.error || result.bodyPreview,
      })),
  };

  const outDir = path.join(process.cwd(), 'evidence');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `load-test-ingest-preview-${nowStamp()}.json`);
  fs.writeFileSync(outFile, JSON.stringify(evidence, null, 2));

  console.log(`Evidence written to ${outFile}`);
  console.log(`Requests: ${successful}/${results.length} succeeded`);
  console.log(`Observed RPS: ${evidence.observedRps}`);
  console.log(`Latency p95: ${evidence.latencyMs.p95}ms`);

  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
