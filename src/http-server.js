#!/usr/bin/env node
// ============================================================
// PROSPECTOR MCP — HTTP/SSE Transport Server
// ============================================================
// Alternative transport for remote deployment (Cloudflare Workers,
// Railway, Render, etc). Supports Streamable HTTP transport.
//
// Run: node src/http-server.js
// Or: PROSPECTOR_PORT=8080 node src/http-server.js
// ============================================================

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { createServer } from 'http';

import {
  verifyEmail,
  verifyMX,
  generateEmailCandidates,
  scrapeEmailsFromWebsite,
  detectCatchAll,
} from './email-engine.js';

import { checkQuota, recordUsage, getUsageStats, getGlobalStats } from './metering.js';

const PORT = parseInt(process.env.PROSPECTOR_PORT || '3100');

// ── Server Factory ───────────────────────────────────────────
// Creates a fresh MCP server per session for HTTP transport.

function createMcpServer() {
  const server = new McpServer({
    name: 'prospector',
    version: '1.0.0',
  });

  // Helper: extract client ID from context or use default
  function getClientId(extra) {
    return extra?.apiKey || extra?.clientId || 'http-anonymous';
  }

  function getClientTier(extra) {
    return extra?.tier || 'free';
  }

  // verify_email
  server.tool(
    'verify_email',
    'Verify if an email address is valid and deliverable via DNS MX + SMTP handshake. Returns confidence score (0-100).',
    { email: z.string().email().describe('Email address to verify') },
    async ({ email }, extra) => {
      const clientId = getClientId(extra);
      const tier = getClientTier(extra);
      const quota = checkQuota(clientId, tier, 1);
      if (!quota.allowed) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'quota_exceeded', ...quota }) }] };
      }
      const result = await verifyEmail(email);
      recordUsage(clientId, 1);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  // verify_emails_batch
  server.tool(
    'verify_emails_batch',
    'Verify multiple email addresses in batch (max 25). Returns status and score for each.',
    { emails: z.array(z.string().email()).max(25).describe('Email addresses to verify') },
    async ({ emails }, extra) => {
      const clientId = getClientId(extra);
      const tier = getClientTier(extra);
      const quota = checkQuota(clientId, tier, emails.length);
      if (!quota.allowed) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'quota_exceeded', ...quota }) }] };
      }
      const results = [];
      for (let i = 0; i < emails.length; i += 4) {
        const batch = emails.slice(i, i + 4);
        const batchResults = await Promise.all(batch.map(verifyEmail));
        results.push(...batchResults);
        if (i + 4 < emails.length) await new Promise(r => setTimeout(r, 800));
      }
      recordUsage(clientId, emails.length);
      const summary = {
        total: results.length,
        valid: results.filter(r => r.status === 'valid').length,
        invalid: results.filter(r => r.status === 'invalid').length,
        risky: results.filter(r => r.status === 'risky').length,
        unknown: results.filter(r => r.status === 'unknown').length,
        average_score: Math.round(results.reduce((s, r) => s + (r.score || 0), 0) / results.length),
      };
      return { content: [{ type: 'text', text: JSON.stringify({ summary, results }, null, 2) }] };
    }
  );

  // find_emails
  server.tool(
    'find_emails',
    'Find email addresses for a business. Scrapes website, generates pattern candidates, verifies via SMTP. Hunter.io replacement — no API key needed.',
    {
      domain: z.string().describe('Business domain (e.g. "acmecorp.com")'),
      website_url: z.string().url().optional().describe('Full website URL'),
      contact_name: z.string().optional().describe('Contact person name for pattern matching'),
    },
    async ({ domain, website_url, contact_name }, extra) => {
      const clientId = getClientId(extra);
      const tier = getClientTier(extra);
      const url = website_url || `https://${domain}`;

      const mx = await verifyMX(domain);
      if (!mx.valid) {
        return { content: [{ type: 'text', text: JSON.stringify({ domain, status: 'invalid_domain', reason: mx.reason, emails: [] }) }] };
      }

      const scraped = await scrapeEmailsFromWebsite(url);

      let candidates = [];
      if (contact_name) {
        const parts = contact_name.trim().split(/\s+/);
        candidates = generateEmailCandidates(parts[0], parts.length > 1 ? parts[parts.length - 1] : '', domain);
        candidates = candidates.filter(c => !scraped.emails.includes(c));
      } else {
        const generic = ['info', 'hello', 'contact', 'admin', 'office', 'team', 'sales'].map(p => `${p}@${domain}`);
        candidates = generic.filter(c => !scraped.emails.includes(c));
      }

      const allEmails = [...new Set([...scraped.emails, ...candidates])];
      const quota = checkQuota(clientId, tier, allEmails.length);
      if (!quota.allowed) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'quota_exceeded', ...quota }) }] };
      }

      const verified = [];
      for (let i = 0; i < allEmails.length; i += 4) {
        const batch = allEmails.slice(i, i + 4);
        const results = await Promise.all(batch.map(verifyEmail));
        verified.push(...results);
        if (i + 4 < allEmails.length) await new Promise(r => setTimeout(r, 500));
      }
      recordUsage(clientId, allEmails.length);
      verified.sort((a, b) => (b.score || 0) - (a.score || 0));

      const validEmails = verified.filter(v => v.status === 'valid' || v.status === 'risky');
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            domain, website: url, mx_host: mx.mx,
            results: verified,
            best_email: validEmails[0]?.email || null,
            confidence: validEmails[0]?.score || 0,
          }, null, 2),
        }],
      };
    }
  );

  // check_domain
  server.tool(
    'check_domain',
    'Quick check if a domain can receive email. Returns MX records and catch-all status.',
    { domain: z.string().describe('Domain to check') },
    async ({ domain }) => {
      const mx = await verifyMX(domain);
      let catchAll = false;
      if (mx.valid) catchAll = await detectCatchAll(domain, mx.mx);
      return {
        content: [{ type: 'text', text: JSON.stringify({ domain, can_receive_email: mx.valid, mx_host: mx.mx || null, all_mx: mx.allMx || [], catch_all: catchAll }) }],
      };
    }
  );

  // usage_stats
  server.tool(
    'usage_stats',
    'Check your current usage quota.',
    {},
    async (_, extra) => {
      const stats = getUsageStats(getClientId(extra), getClientTier(extra));
      return { content: [{ type: 'text', text: JSON.stringify(stats, null, 2) }] };
    }
  );

  return server;
}

// ── HTTP Server ──────────────────────────────────────────────

const httpServer = createServer(async (req, res) => {
  // Health check
  if (req.url === '/health' && req.method === 'GET') {
    const stats = getGlobalStats();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', ...stats }));
    return;
  }

  // MCP endpoint
  if (req.url === '/mcp' || req.url === '/') {
    const mcpServer = createMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID() });
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res);
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

httpServer.listen(PORT, () => {
  console.log(`Prospector MCP HTTP server running on port ${PORT}`);
  console.log(`  MCP endpoint: http://localhost:${PORT}/mcp`);
  console.log(`  Health check: http://localhost:${PORT}/health`);
});
