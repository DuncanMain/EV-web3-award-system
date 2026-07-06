require('dotenv').config();

const fs = require('fs');
const path = require('path');

const BASE_URL = process.env.EVIDENCE_BASE_URL || process.env.API_BASE_URL || 'http://localhost:3000';
const API_KEY = process.env.API_KEY || '';
const INGEST_API_KEY = process.env.INGEST_API_KEY || API_KEY;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const USER_IDENTITY_HEADER = (process.env.USER_IDENTITY_HEADER || 'x-contract-id').toLowerCase();
const CONTRACT_ID = process.env.EVIDENCE_CONTRACT_ID || `trl7-evidence-${Date.now()}`;
const RUN_CDR = process.env.EVIDENCE_RUN_CDR === 'true';
const RUN_RECONCILIATION = process.env.EVIDENCE_RUN_RECONCILIATION === 'true';

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function redact(value) {
  if (!value) return value;
  if (typeof value !== 'string') return '[redacted]';
  if (value.length <= 8) return '[redacted]';
  return `${value.slice(0, 4)}...[redacted]...${value.slice(-4)}`;
}

async function requestEvidence(label, method, route, options = {}) {
  const headers = {
    ...(options.headers || {}),
  };
  if (options.apiKey) headers['X-API-Key'] = options.apiKey;
  if (options.ingestKey) headers['X-Ingest-API-Key'] = options.ingestKey;
  if (options.adminToken) headers.Authorization = `Bearer ${options.adminToken}`;
  if (options.identity) headers[USER_IDENTITY_HEADER] = options.identity;
  if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';

  const startedAt = new Date().toISOString();
  try {
    const res = await fetch(`${BASE_URL}${route}`, {
      method,
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const text = await res.text();
    let body;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return {
      label,
      route,
      method,
      ok: res.ok,
      status: res.status,
      startedAt,
      completedAt: new Date().toISOString(),
      body,
    };
  } catch (err) {
    return {
      label,
      route,
      method,
      ok: false,
      status: null,
      startedAt,
      completedAt: new Date().toISOString(),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function sampleCdr() {
  const start = new Date();
  start.setUTCDate(start.getUTCDate() - 1);
  start.setUTCHours(23, 0, 0, 0);
  const end = new Date(start);
  end.setUTCMinutes(end.getUTCMinutes() + 45);

  return {
    SessionID: `trl7-evidence-session-${Date.now()}`,
    ProviderID: 'trl7-evidence-provider',
    EVSEID: 'DE*NVF*EVIDENCE01',
    cdr_token: { contract_id: CONTRACT_ID },
    StartTime: start.toISOString(),
    EndTime: end.toISOString(),
    Energy: '12.5',
    EnergyDirection: 'CHARGE',
  };
}

async function main() {
  const evidence = {
    generatedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    contractId: CONTRACT_ID,
    runOptions: {
      runCdr: RUN_CDR,
      runReconciliation: RUN_RECONCILIATION,
    },
    environment: {
      apiKeyConfigured: Boolean(API_KEY),
      ingestApiKeyConfigured: Boolean(INGEST_API_KEY),
      adminEmailConfigured: Boolean(ADMIN_EMAIL),
      adminPasswordConfigured: Boolean(ADMIN_PASSWORD),
      userIdentityHeader: USER_IDENTITY_HEADER,
      apiKeyPreview: redact(API_KEY),
      ingestApiKeyPreview: redact(INGEST_API_KEY),
    },
    steps: [],
  };

  evidence.steps.push(await requestEvidence('health_check', 'GET', '/ingest/health'));

  evidence.steps.push(await requestEvidence('identity_wallet_snapshot', 'GET', '/wallet/me', {
    apiKey: API_KEY,
    identity: CONTRACT_ID,
  }));

  if (RUN_CDR) {
    evidence.steps.push(await requestEvidence('sample_cdr_ingestion', 'POST', '/ingest/cdr', {
      ingestKey: INGEST_API_KEY,
      body: sampleCdr(),
    }));
  }

  let adminToken = null;
  if (ADMIN_EMAIL && ADMIN_PASSWORD) {
    const login = await requestEvidence('admin_login', 'POST', '/admin/login', {
      body: {
        email: ADMIN_EMAIL,
        password: ADMIN_PASSWORD,
      },
    });
    evidence.steps.push({
      ...login,
      body: login.body && typeof login.body === 'object'
        ? { ...login.body, token: login.body.token ? redact(login.body.token) : undefined }
        : login.body,
    });
    adminToken = login.body && login.body.token ? login.body.token : null;
  }

  if (adminToken) {
    if (RUN_RECONCILIATION) {
      evidence.steps.push(await requestEvidence('run_reconciliation', 'POST', '/admin/reconciliation/run', {
        adminToken,
        body: { limit: 500 },
      }));
    }

    evidence.steps.push(await requestEvidence('recent_reconciliation_reports', 'GET', '/admin/reconciliation?limit=5', {
      adminToken,
    }));
    evidence.steps.push(await requestEvidence('audit_retry_required', 'GET', '/admin/audit?limit=25&status=retry_required', {
      adminToken,
    }));
    evidence.steps.push(await requestEvidence('audit_warnings', 'GET', '/admin/audit?limit=25&status=warning', {
      adminToken,
    }));
    evidence.steps.push(await requestEvidence('audit_errors', 'GET', '/admin/audit?limit=25&status=error', {
      adminToken,
    }));
  }

  evidence.summary = {
    totalSteps: evidence.steps.length,
    successfulSteps: evidence.steps.filter(step => step.ok).length,
    failedSteps: evidence.steps.filter(step => !step.ok).map(step => ({
      label: step.label,
      status: step.status,
      error: step.error || step.body?.message || step.body?.error || null,
    })),
  };

  const outDir = path.join(process.cwd(), 'evidence');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `pilot-evidence-${nowStamp()}.json`);
  fs.writeFileSync(outFile, JSON.stringify(evidence, null, 2));

  console.log(`Evidence written to ${outFile}`);
  console.log(`Successful steps: ${evidence.summary.successfulSteps}/${evidence.summary.totalSteps}`);
  if (evidence.summary.failedSteps.length) {
    console.log('Failed or unavailable steps:');
    for (const step of evidence.summary.failedSteps) {
      console.log(`- ${step.label}: ${step.status || 'no status'} ${step.error || ''}`.trim());
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
