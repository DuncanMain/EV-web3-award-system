/*
 * Keeps the existing local award-flow harness alive for browser verification.
 * The fixture owns a disposable PostgreSQL container, a local Hardhat 31337
 * node, and a compiled API process. It never targets the dashboard database.
 * Synthetic credentials are intentionally not printed; pass them only to the
 * local browser or the local package proxy when testing.
 */
'use strict';

const path = require('node:path');

const HARNESS_PATH = path.join(__dirname, 'verify-local-award-flow.js');

function loadHarness() {
  return require(HARNESS_PATH);
}

async function main() {
  const harness = loadHarness();
  let fixtureReady = false;
  try {
    await harness.startDatabase();
    const { provider } = await harness.startHardhat();
    const { treasuryAddress } = await harness.deployToken(provider);
    const alertWebhook = process.env.NVF_FIXTURE_ALERT_WEBHOOK === '1'
      ? await harness.startAlertWebhook()
      : null;
    await harness.startApi(treasuryAddress, {
      adminAlertWebhookUrl: alertWebhook?.url,
    });

    const award = harness.assertHttp(await harness.postIngest({
      SessionID: 'browser-fixture-award-1',
      ProviderID: harness.PROVIDER_ID,
      EVSEID: harness.EVSE_ID,
      'Session Start': '2026-01-01T01:00:00Z',
      'Session End': '2026-01-01T02:00:00Z',
      'Consumed Energy': '40',
      cdr_token: { contract_id: harness.UID },
    }), 200, 'browser fixture seed award');
    const wallet = harness.assertHttp(await harness.getIdentityWallet(), 200, 'browser fixture wallet');
    fixtureReady = true;
    console.log(JSON.stringify({
      status: 'fixture_ready',
      apiBaseUrl: harness.resources.apiBaseUrl,
      eMAID: harness.UID,
      adminEmail: harness.ADMIN_EMAIL,
      adminPasswordAvailable: true,
      apiKeyAvailable: true,
      ingestApiKeyAvailable: true,
      localAlertWebhookAvailable: Boolean(alertWebhook),
      walletAddress: wallet.walletAddress,
      seededAwardStatus: award.status,
      hardhatPort: harness.resources.hardhatPort,
      disposableDatabasePort: harness.resources.dbPort,
    }, null, 2));
    await new Promise(resolve => process.once('SIGINT', resolve));
  } finally {
    await harness.cleanup();
    if (fixtureReady) console.log('fixture_stopped=true');
  }
}

main().catch(error => {
  console.error(JSON.stringify({ status: 'fixture_failed', error: error?.message || String(error) }, null, 2));
  process.exitCode = 1;
});
