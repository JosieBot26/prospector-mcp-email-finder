#!/usr/bin/env node
// ============================================================
// PROSPECTOR MCP — B2B Email Finder & Verification Server
// ============================================================
// A self-contained MCP server for finding and verifying business
// email addresses. No paid API subscriptions required.
//
// Transport: stdio (for Claude Code, Cursor, Windsurf, etc.)
// Run: npx prospector-mcp
// ============================================================

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import {
  verifyEmail,
  verifyMX,
  generateEmailCandidates,
  scrapeEmailsFromWebsite,
  detectCatchAll,
} from './email-engine.js';

import { checkQuota, recordUsage, getUsageStats } from './metering.js';

// ── Server Setup ─────────────────────────────────────────────

const server = new McpServer({
  name: 'prospector',
  version: '1.0.0',
});

// Client ID for metering (stdio = single client)
const CLIENT_ID = process.env.PROSPECTOR_API_KEY || 'stdio-default';
const CLIENT_TIER = process.env.PROSPECTOR_TIER || 'free';

// ── Helper: Quota Gate ───────────────────────────────────────

function enforceQuota(count = 1) {
  const quota = checkQuota(CLIENT_ID, CLIENT_TIER, count);
  if (!quota.allowed) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: 'quota_exceeded',
          message: `Daily limit reached (${quota.limit} verifications/day on ${CLIENT_TIER} tier). Resets at midnight UTC.`,
          used: quota.used,
          limit: quota.limit,
          upgrade: 'Set PROSPECTOR_TIER=pro for 500/day or business for 2000/day',
        }, null, 2),
      }],
    };
  }
  return null;
}

// ── Tool: verify_email ───────────────────────────────────────

server.tool(
  'verify_email',
  `Verify if an email address is valid and deliverable. Performs DNS MX lookup, SMTP handshake verification (without sending email), catch-all detection, and disposable domain detection. Returns a confidence score (0-100).`,
  { email: z.string().email().describe('Email address to verify') },
  async ({ email }) => {
    const quotaError = enforceQuota(1);
    if (quotaError) return quotaError;

    const result = await verifyEmail(email);
    recordUsage(CLIENT_ID, 1);

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ── Tool: verify_emails_batch ────────────────────────────────

server.tool(
  'verify_emails_batch',
  `Verify multiple email addresses in a single batch (max 25). Returns verification status and confidence score for each email. Efficient for cleaning outreach lists.`,
  {
    emails: z.array(z.string().email()).max(25).describe('Email addresses to verify (max 25)'),
  },
  async ({ emails }) => {
    const quotaError = enforceQuota(emails.length);
    if (quotaError) return quotaError;

    const results = [];
    // Process 4 at a time
    for (let i = 0; i < emails.length; i += 4) {
      const batch = emails.slice(i, i + 4);
      const batchResults = await Promise.all(batch.map(verifyEmail));
      results.push(...batchResults);
      if (i + 4 < emails.length) await new Promise(r => setTimeout(r, 800));
    }

    recordUsage(CLIENT_ID, emails.length);

    const summary = {
      total: results.length,
      valid: results.filter(r => r.status === 'valid').length,
      invalid: results.filter(r => r.status === 'invalid').length,
      risky: results.filter(r => r.status === 'risky').length,
      unknown: results.filter(r => r.status === 'unknown').length,
      average_score: Math.round(results.reduce((s, r) => s + (r.score || 0), 0) / results.length),
    };

    return {
      content: [{ type: 'text', text: JSON.stringify({ summary, results }, null, 2) }],
    };
  }
);

// ── Tool: find_emails ────────────────────────────────────────

server.tool(
  'find_emails',
  `Find email addresses for a business. Scrapes their website for contact info, generates pattern-based candidates from a contact name, and verifies all discovered emails via SMTP. Returns verified emails sorted by confidence score. This is your Hunter.io replacement — no API key needed.`,
  {
    domain: z.string().describe('Business domain (e.g. "acmecorp.com")'),
    website_url: z.string().url().optional().describe('Full website URL if different from https://domain'),
    contact_name: z.string().optional().describe('Contact person name for pattern matching (e.g. "Jane Smith")'),
  },
  async ({ domain, website_url, contact_name }) => {
    const url = website_url || `https://${domain}`;

    // Check MX first
    const mx = await verifyMX(domain);
    if (!mx.valid) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            domain,
            status: 'invalid_domain',
            reason: mx.reason,
            emails: [],
            message: `Domain ${domain} cannot receive email: ${mx.reason}`,
          }, null, 2),
        }],
      };
    }

    // Scrape website
    const scraped = await scrapeEmailsFromWebsite(url);

    // Generate pattern candidates
    let candidates = [];
    if (contact_name) {
      const parts = contact_name.trim().split(/\s+/);
      const firstName = parts[0];
      const lastName = parts.length > 1 ? parts[parts.length - 1] : '';
      candidates = generateEmailCandidates(firstName, lastName, domain);
      candidates = candidates.filter(c => !scraped.emails.includes(c));
    } else {
      const generic = ['info', 'hello', 'contact', 'admin', 'office', 'team', 'sales']
        .map(p => `${p}@${domain}`);
      candidates = generic.filter(c => !scraped.emails.includes(c));
    }

    // Verify all
    const allEmails = [...new Set([...scraped.emails, ...candidates])];
    const estimatedVerifications = allEmails.length;
    const quotaError = enforceQuota(estimatedVerifications);
    if (quotaError) return quotaError;

    const verified = [];
    for (let i = 0; i < allEmails.length; i += 4) {
      const batch = allEmails.slice(i, i + 4);
      const results = await Promise.all(batch.map(verifyEmail));
      verified.push(...results);
      if (i + 4 < allEmails.length) await new Promise(r => setTimeout(r, 500));
    }

    recordUsage(CLIENT_ID, estimatedVerifications);

    // Sort by score descending
    verified.sort((a, b) => (b.score || 0) - (a.score || 0));

    const validEmails = verified.filter(v => v.status === 'valid' || v.status === 'risky');

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          domain,
          website: url,
          mx_host: mx.mx,
          mx_providers: mx.allMx,
          pages_checked: scraped.pagesChecked,
          emails_scraped: scraped.emails.length,
          patterns_tested: candidates.length,
          total_verified: verified.length,
          results: verified,
          best_email: validEmails[0]?.email || null,
          confidence: validEmails[0]?.score || 0,
        }, null, 2),
      }],
    };
  }
);

// ── Tool: check_domain ───────────────────────────────────────

server.tool(
  'check_domain',
  `Quick check if a domain can receive email. Verifies DNS MX records exist and returns mail server details. Use this to filter out dead domains before running find_emails. Does not count against your verification quota.`,
  {
    domain: z.string().describe('Domain to check (e.g. "example.com")'),
  },
  async ({ domain }) => {
    const mx = await verifyMX(domain);
    let catchAll = false;
    if (mx.valid) {
      catchAll = await detectCatchAll(domain, mx.mx);
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          domain,
          can_receive_email: mx.valid,
          mx_host: mx.mx || null,
          all_mx: mx.allMx || [],
          catch_all: catchAll,
          reason: mx.reason || 'ok',
        }, null, 2),
      }],
    };
  }
);

// ── Tool: usage_stats ────────────────────────────────────────

server.tool(
  'usage_stats',
  `Check your current usage quota. Shows how many verifications you've used today, your remaining quota, and your tier.`,
  {},
  async () => {
    const stats = getUsageStats(CLIENT_ID, CLIENT_TIER);
    return {
      content: [{ type: 'text', text: JSON.stringify(stats, null, 2) }],
    };
  }
);

// ── Start Server ─────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Prospector MCP server running on stdio');
}

main().catch((err) => {
  console.error('Failed to start Prospector MCP server:', err);
  process.exit(1);
});
