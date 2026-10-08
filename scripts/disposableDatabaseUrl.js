'use strict';

const DATABASE_NAME = /^nvf_award_(?:test|check)_[a-z0-9_-]+$/i;

/**
 * Validate a caller-supplied database target used only by disposable checks.
 * node-postgres accepts query parameters that can override URL authority, so
 * query strings and fragments are deliberately rejected as well as remote or
 * default-port targets.
 */
function parseDisposableDatabaseUrl(databaseUrl) {
  if (typeof databaseUrl !== 'string' || !databaseUrl.trim()) {
    throw new Error('a database URL is required');
  }

  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch (error) {
    throw new Error(`invalid PostgreSQL URL: ${error.message}`);
  }

  let databaseName;
  try {
    databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  } catch (error) {
    throw new Error(`invalid database name: ${error.message}`);
  }

  if (
    parsed.protocol !== 'postgres:'
    || !['127.0.0.1', 'localhost'].includes(parsed.hostname.toLowerCase())
    || !/^\d+$/.test(parsed.port)
    || Number(parsed.port) < 1
    || Number(parsed.port) > 65535
    || !DATABASE_NAME.test(databaseName)
    || parsed.search
    || parsed.hash
    || /[?#]/.test(databaseUrl)
  ) {
    throw new Error(
      'refusing non-disposable database target; use a loopback postgres URL with an explicit port and an nvf_award_test_* or nvf_award_check_* database',
    );
  }

  return { databaseName, port: Number(parsed.port) };
}

module.exports = { parseDisposableDatabaseUrl };
