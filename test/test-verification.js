#!/usr/bin/env node
// ============================================================
// Prospector — Verification Engine Test Suite
// ============================================================
// Tests email verification against diverse domain types.
// Run: node test/test-verification.js
// ============================================================

import {
  verifyEmail,
  verifyMX,
  detectCatchAll,
  generateEmailCandidates,
  scrapeEmailsFromWebsite,
} from '../src/email-engine.js';

const PASS = '\x1b[32mPASS\x1b[0m';
const FAIL = '\x1b[31mFAIL\x1b[0m';
const SKIP = '\x1b[33mSKIP\x1b[0m';

let passed = 0;
let failed = 0;
let skipped = 0;

function assert(test, description, actual, expected) {
  if (test) {
    console.log(`  ${PASS} ${description}`);
    passed++;
  } else {
    console.log(`  ${FAIL} ${description}`);
    console.log(`       Expected: ${JSON.stringify(expected)}`);
    console.log(`       Actual:   ${JSON.stringify(actual)}`);
    failed++;
  }
}

async function testSection(name, fn) {
  console.log(`\n--- ${name} ---`);
  try {
    await fn();
  } catch (err) {
    console.log(`  ${FAIL} Section error: ${err.message}`);
    failed++;
  }
}

// ── Tests ────────────────────────────────────────────────────

await testSection('Pattern Generation', async () => {
  const candidates = generateEmailCandidates('Jane', 'Smith', 'acme.com');
  assert(candidates.includes('jane@acme.com'), 'Generates firstname@domain', true, true);
  assert(candidates.includes('jane.smith@acme.com'), 'Generates first.last@domain', true, true);
  assert(candidates.includes('jsmith@acme.com'), 'Generates flast@domain', true, true);
  assert(candidates.includes('smith.jane@acme.com'), 'Generates last.first@domain', true, true);
  assert(candidates.includes('info@acme.com'), 'Includes generic info@', true, true);
  assert(candidates.includes('contact@acme.com'), 'Includes generic contact@', true, true);
  assert(candidates.length >= 15, 'Generates 15+ candidates', candidates.length, '>=15');

  // No last name
  const noLast = generateEmailCandidates('Jane', '', 'acme.com');
  assert(noLast.includes('jane@acme.com'), 'Works with first name only', true, true);
  assert(noLast.includes('info@acme.com'), 'Still includes generics', true, true);
});

await testSection('MX Verification — Valid Domains', async () => {
  // Major providers
  const gmail = await verifyMX('gmail.com');
  assert(gmail.valid === true, 'gmail.com has MX records', gmail.valid, true);
  assert(gmail.mx.includes('google'), 'gmail.com MX is Google', gmail.mx, 'contains google');

  const outlook = await verifyMX('outlook.com');
  assert(outlook.valid === true, 'outlook.com has MX records', outlook.valid, true);

  const yahoo = await verifyMX('yahoo.com');
  assert(yahoo.valid === true, 'yahoo.com has MX records', yahoo.valid, true);
});

await testSection('MX Verification — Invalid Domains', async () => {
  const fake = await verifyMX('this-domain-definitely-does-not-exist-xyz.com');
  assert(fake.valid === false, 'Fake domain has no MX', fake.valid, false);

  const noTld = await verifyMX('notadomain');
  assert(noTld.valid === false, 'Non-domain fails', noTld.valid, false);
});

await testSection('MX Verification — Business Domains', async () => {
  // Real businesses of various sizes
  const domains = [
    'stripe.com',
    'shopify.com',
    'basecamp.com',
    'linear.app',
    'github.com',
  ];

  for (const domain of domains) {
    const result = await verifyMX(domain);
    assert(result.valid === true, `${domain} has MX records`, result.valid, true);
  }
});

await testSection('Full Email Verification — Known Valid', async () => {
  // Test against well-known addresses that should be valid
  // (using postmaster@ which RFC requires all domains to accept)
  const result = await verifyEmail('postmaster@gmail.com');
  assert(
    result.status === 'valid' || result.status === 'risky' || result.status === 'unknown',
    'postmaster@gmail.com is not invalid',
    result.status,
    'valid/risky/unknown'
  );
  assert(result.score > 0, 'Has positive score', result.score, '>0');
});

await testSection('Full Email Verification — Known Invalid', async () => {
  // Bad format
  const badFormat = await verifyEmail('not-an-email');
  assert(badFormat.status === 'invalid', 'Bad format detected', badFormat.status, 'invalid');
  assert(badFormat.reason === 'bad_format', 'Reason is bad_format', badFormat.reason, 'bad_format');

  // Disposable domain
  const disposable = await verifyEmail('test@mailinator.com');
  assert(disposable.status === 'invalid', 'Disposable detected', disposable.status, 'invalid');
  assert(disposable.reason === 'disposable_domain', 'Reason is disposable', disposable.reason, 'disposable_domain');

  // Non-existent domain
  const noDomain = await verifyEmail('test@zzzz-not-real-domain.com');
  assert(noDomain.status === 'invalid', 'Non-existent domain detected', noDomain.status, 'invalid');

  // Random address at real domain (likely invalid)
  const random = await verifyEmail(`nonexistent-test-${Date.now()}@stripe.com`);
  // This should be invalid OR unknown (depends on SMTP behavior)
  assert(
    random.status !== 'valid',
    'Random address at stripe.com is not "valid"',
    random.status,
    'invalid/unknown'
  );
});

await testSection('Full Email Verification — Score Checks', async () => {
  const valid = await verifyEmail('postmaster@gmail.com');
  assert(typeof valid.score === 'number', 'Score is a number', typeof valid.score, 'number');
  assert(valid.score >= 0 && valid.score <= 100, 'Score is 0-100', valid.score, '0-100');

  const invalid = await verifyEmail('fake@zzzz-no-domain.com');
  assert(invalid.score === 0, 'Invalid email has score 0', invalid.score, 0);
});

await testSection('Website Scraping', async () => {
  // Test against a simple website
  const result = await scrapeEmailsFromWebsite('https://stripe.com');
  assert(Array.isArray(result.emails), 'Returns emails array', true, true);
  assert(Array.isArray(result.pagesChecked), 'Returns pagesChecked array', true, true);
  assert(result.pagesChecked.length >= 1, 'Checked at least 1 page', result.pagesChecked.length, '>=1');
  console.log(`       Found ${result.emails.length} emails on stripe.com`);
});

await testSection('Metering', async () => {
  const { checkQuota, recordUsage, getUsageStats } = await import('../src/metering.js');

  // Fresh client should have full quota
  const testClient = `test-${Date.now()}`;
  const quota = checkQuota(testClient, 'free', 1);
  assert(quota.allowed === true, 'Fresh client is allowed', quota.allowed, true);
  assert(quota.remaining === 50, 'Free tier has 50 remaining', quota.remaining, 50);

  // Use some quota
  recordUsage(testClient, 10);
  const after = checkQuota(testClient, 'free', 1);
  assert(after.remaining === 40, 'After 10 uses, 40 remaining', after.remaining, 40);

  // Exceed quota
  recordUsage(testClient, 40);
  const exceeded = checkQuota(testClient, 'free', 1);
  assert(exceeded.allowed === false, 'Quota exceeded blocks requests', exceeded.allowed, false);

  // Pro tier has higher limit
  const proQuota = checkQuota(`pro-${Date.now()}`, 'pro', 1);
  assert(proQuota.limit === 500, 'Pro tier has 500 limit', proQuota.limit, 500);

  // Stats
  const stats = getUsageStats(testClient, 'free');
  assert(stats.used === 50, 'Stats show 50 used', stats.used, 50);
  assert(stats.remaining === 0, 'Stats show 0 remaining', stats.remaining, 0);
});

// ── Summary ──────────────────────────────────────────────────

console.log(`\n========================================`);
console.log(`Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
console.log(`========================================\n`);

process.exit(failed > 0 ? 1 : 0);
