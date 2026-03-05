import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { Request, Response } from "express";
import { z } from "zod";
import chalk from "chalk";
import dns from "dns/promises";
import net from "net";

// ============================================================================
// Dev Logging Utilities
// ============================================================================

const isDev = process.env.NODE_ENV !== "production";

function timestamp(): string {
  return new Date().toLocaleTimeString("en-US", { hour12: false });
}

function formatLatency(ms: number): string {
  if (ms < 100) return chalk.green(`${ms}ms`);
  if (ms < 500) return chalk.yellow(`${ms}ms`);
  return chalk.red(`${ms}ms`);
}

function truncate(str: string, maxLen = 60): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + "...";
}

function logRequest(method: string, params?: unknown): void {
  if (!isDev) return;
  const paramsStr = params ? chalk.gray(` ${truncate(JSON.stringify(params))}`) : "";
  console.log(`${chalk.gray(`[${timestamp()}]`)} ${chalk.cyan("→")} ${method}${paramsStr}`);
}

function logResponse(method: string, result: unknown, latencyMs: number): void {
  if (!isDev) return;
  const latency = formatLatency(latencyMs);
  if (method === "tools/call" && result) {
    const resultStr = typeof result === "string" ? result : JSON.stringify(result);
    console.log(`${chalk.gray(`[${timestamp()}]`)} ${chalk.green("←")} ${truncate(resultStr)} ${chalk.gray(`(${latency})`)}`);
  } else {
    console.log(`${chalk.gray(`[${timestamp()}]`)} ${chalk.green("✓")} ${method} ${chalk.gray(`(${latency})`)}`);
  }
}

function logError(method: string, error: unknown, latencyMs: number): void {
  const latency = formatLatency(latencyMs);
  let errorMsg: string;
  if (error instanceof Error) errorMsg = error.message;
  else if (typeof error === "object" && error !== null) {
    const rpcError = error as { message?: string; code?: number };
    errorMsg = rpcError.message || `Error ${rpcError.code || "unknown"}`;
  } else errorMsg = String(error);
  console.log(`${chalk.gray(`[${timestamp()}]`)} ${chalk.red("✖")} ${method} ${chalk.red(truncate(errorMsg))} ${chalk.gray(`(${latency})`)}`);
}

// ============================================================================
// Email Engine — DNS/SMTP Verification & Web Scraping
// ============================================================================

const COMMON_PATTERNS = [
  (f: string, l: string, d: string) => `${f}@${d}`,
  (f: string, l: string, d: string) => `${f}.${l}@${d}`,
  (f: string, l: string, d: string) => `${f}${l}@${d}`,
  (f: string, l: string, d: string) => `${f[0]}${l}@${d}`,
  (f: string, l: string, d: string) => `${f[0]}.${l}@${d}`,
  (f: string, l: string, d: string) => `${f}.${l[0]}@${d}`,
  (f: string, l: string, d: string) => `${f}${l[0]}@${d}`,
  (f: string, l: string, d: string) => `${l}.${f}@${d}`,
  (f: string, l: string, d: string) => `${l}${f}@${d}`,
  (f: string, l: string, d: string) => `${l}@${d}`,
  (f: string, l: string, d: string) => `${f}_${l}@${d}`,
  (f: string, l: string, d: string) => `${f}-${l}@${d}`,
];

const GENERIC_PREFIXES = ['info', 'hello', 'contact', 'admin', 'office', 'team', 'support', 'sales'];

const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com', 'guerrillamail.com', 'tempmail.com', 'throwaway.email',
  'yopmail.com', 'sharklasers.com', 'grr.la', 'temp-mail.org',
  'dispostable.com', 'maildrop.cc', 'guerrillamail.info', 'trashmail.com',
]);

const FREE_PROVIDERS = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com',
  'icloud.com', 'mail.com', 'protonmail.com', 'zoho.com', 'live.com',
]);

const IGNORE_DOMAINS = new Set([
  'example.com', 'sentry.io', 'wixpress.com', 'schema.org', 'w3.org',
  'wordpress.org', 'googleapis.com', 'cloudflare.com', 'facebook.com',
]);

const FILE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.css', '.js', '.woff', '.ico', '.webp']);

function generateEmailCandidates(firstName: string | undefined, lastName: string | undefined, domain: string): string[] {
  const candidates = new Set<string>();
  const f = firstName?.toLowerCase().trim();
  const l = lastName?.toLowerCase().trim();
  if (f && l) {
    for (const pattern of COMMON_PATTERNS) {
      try { candidates.add(pattern(f, l, domain)); } catch { /* skip */ }
    }
  } else if (f) {
    candidates.add(`${f}@${domain}`);
  }
  for (const prefix of GENERIC_PREFIXES) candidates.add(`${prefix}@${domain}`);
  return [...candidates];
}

async function verifyMX(domain: string) {
  try {
    const records = await dns.resolveMx(domain);
    if (!records || records.length === 0) return { valid: false as const, reason: 'no_mx_records', mx: '', allMx: [] as Array<{ host: string; priority: number }> };
    records.sort((a, b) => a.priority - b.priority);
    return { valid: true as const, mx: records[0].exchange, allMx: records.map(r => ({ host: r.exchange, priority: r.priority })), reason: '' };
  } catch (err: any) {
    if (err.code === 'ENOTFOUND' || err.code === 'ENODATA') return { valid: false as const, reason: 'domain_not_found', mx: '', allMx: [] as Array<{ host: string; priority: number }> };
    return { valid: false as const, reason: `dns_error: ${err.code || err.message}`, mx: '', allMx: [] as Array<{ host: string; priority: number }> };
  }
}

async function verifySMTP(email: string, mxHost: string, timeoutMs = 10000): Promise<{ valid: boolean | 'unknown'; reason: string; code: number | null }> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let step = 0;
    let resolved = false;
    const done = (result: { valid: boolean | 'unknown'; reason: string; code: number | null }) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => done({ valid: 'unknown', reason: 'timeout', code: null }), timeoutMs);
    socket.on('error', () => done({ valid: 'unknown', reason: 'connection_error', code: null }));
    socket.on('close', () => done({ valid: 'unknown', reason: 'connection_closed', code: null }));
    socket.on('data', (data) => {
      const response = data.toString();
      const code = parseInt(response.slice(0, 3));
      if (step === 0 && code === 220) { step = 1; socket.write('HELO prospector.local\r\n'); }
      else if (step === 1 && code === 250) { step = 2; socket.write('MAIL FROM:<verify@prospector.local>\r\n'); }
      else if (step === 2 && code === 250) { step = 3; socket.write(`RCPT TO:<${email}>\r\n`); }
      else if (step === 3) {
        if (code === 250 || code === 251) done({ valid: true, reason: 'accepted', code });
        else if (code >= 550 && code <= 554) done({ valid: false, reason: 'rejected', code });
        else if (code >= 450 && code <= 452) done({ valid: 'unknown', reason: 'temporary_error', code });
        else done({ valid: 'unknown', reason: `smtp_${code}`, code });
        socket.write('QUIT\r\n');
      } else if (code >= 500) done({ valid: 'unknown', reason: `smtp_error_${code}`, code });
    });
    socket.connect(25, mxHost);
  });
}

async function detectCatchAll(domain: string, mxHost: string): Promise<boolean> {
  const random = `xq7z9-nonexist-${Date.now()}@${domain}`;
  const result = await verifySMTP(random, mxHost, 8000);
  return result.valid === true;
}

async function verifyEmail(email: string) {
  const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  if (!emailRegex.test(email)) return { email, status: 'invalid', reason: 'bad_format', score: 0 };
  const domain = email.split('@')[1];
  if (DISPOSABLE_DOMAINS.has(domain)) return { email, status: 'invalid', reason: 'disposable_domain', score: 0 };
  const isFree = FREE_PROVIDERS.has(domain);
  const mx = await verifyMX(domain);
  if (!mx.valid) return { email, status: 'invalid', reason: mx.reason, domain, score: 0 };
  try {
    const smtp = await verifySMTP(email, mx.mx);
    if (smtp.valid === false) return { email, status: 'invalid', reason: 'mailbox_not_found', domain, mx_host: mx.mx, smtp_code: smtp.code, score: 0 };
    if (smtp.valid === true) {
      const catchAll = await detectCatchAll(domain, mx.mx);
      const score = catchAll ? 50 : (isFree ? 80 : 95);
      return { email, status: catchAll ? 'risky' : 'valid', reason: catchAll ? 'catch_all_domain' : 'verified', domain, mx_host: mx.mx, catch_all: catchAll, free_provider: isFree, score };
    }
    return { email, status: 'unknown', reason: smtp.reason, domain, mx_host: mx.mx, smtp_code: smtp.code, score: 30 };
  } catch {
    return { email, status: 'unknown', reason: 'smtp_check_failed', domain, mx_host: mx.mx, score: 20 };
  }
}

function isValidScrapedEmail(email: string): boolean {
  const domain = email.split('@')[1];
  if (!domain) return false;
  if (IGNORE_DOMAINS.has(domain)) return false;
  for (const ext of FILE_EXTS) { if (email.endsWith(ext)) return false; }
  return true;
}

async function scrapeEmailsFromWebsite(websiteUrl: string) {
  const emails = new Set<string>();
  const pagesChecked: string[] = [];
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const mailtoRegex = /mailto:([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/gi;

  async function fetchPage(url: string): Promise<string | null> {
    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Prospector/1.0; +https://github.com/JosieBot26/prospector-mcp-email-finder)' },
        signal: AbortSignal.timeout(12000), redirect: 'follow',
      });
      return resp.ok ? await resp.text() : null;
    } catch { return null; }
  }

  function extract(html: string) {
    for (const m of html.matchAll(emailRegex)) { const e = m[0].toLowerCase(); if (isValidScrapedEmail(e)) emails.add(e); }
    for (const m of html.matchAll(mailtoRegex)) { const e = m[1].toLowerCase(); if (isValidScrapedEmail(e)) emails.add(e); }
  }

  try {
    const html = await fetchPage(websiteUrl);
    if (!html) return { emails: [] as string[], pagesChecked, error: 'Could not fetch website' };
    pagesChecked.push(websiteUrl);
    extract(html);

    const baseUrl = new URL(websiteUrl).origin;
    const contactPaths = new Set(['/contact', '/contact-us', '/about', '/about-us', '/connect', '/info']);
    const linkRegex = /href=["']([^"']*(?:contact|about|connect|reach|info|team)[^"']*)/gi;
    for (const m of html.matchAll(linkRegex)) {
      const path = m[1];
      if (path.startsWith('/')) contactPaths.add(path.split('?')[0].split('#')[0]);
    }

    let checked = 0;
    for (const cp of contactPaths) {
      if (checked >= 4) break;
      const url = cp.startsWith('http') ? cp : baseUrl + cp;
      if (pagesChecked.includes(url)) continue;
      const cHtml = await fetchPage(url);
      if (cHtml) { pagesChecked.push(url); checked++; extract(cHtml); }
    }
  } catch (err: any) {
    return { emails: [...emails], pagesChecked, error: err.message };
  }
  return { emails: [...emails], pagesChecked };
}

// ============================================================================
// Usage Metering
// ============================================================================

const FREE_LIMIT = 50;
const TIER_LIMITS: Record<string, number> = { free: 50, pro: 500, business: 2000, unlimited: Infinity };
const usage = new Map<string, { count: number; resetDate: string }>();

function getToday() { return new Date().toISOString().slice(0, 10); }
function getRecord(clientId: string) {
  const today = getToday();
  let rec = usage.get(clientId);
  if (!rec || rec.resetDate !== today) { rec = { count: 0, resetDate: today }; usage.set(clientId, rec); }
  return rec;
}
function checkQuota(clientId: string, tier = 'free', count = 1) {
  const limit = TIER_LIMITS[tier] || FREE_LIMIT;
  const rec = getRecord(clientId);
  return { allowed: rec.count + count <= limit, remaining: Math.max(0, limit - rec.count), limit, used: rec.count, resetDate: rec.resetDate };
}
function recordUsage(clientId: string, count = 1) { getRecord(clientId).count += count; }
function getUsageStats(clientId: string, tier = 'free') {
  const limit = TIER_LIMITS[tier] || FREE_LIMIT;
  const rec = getRecord(clientId);
  return { used: rec.count, remaining: Math.max(0, limit - rec.count), limit, tier, resetDate: rec.resetDate };
}

// ============================================================================
// MCP Server Setup
// ============================================================================

const CLIENT_ID = process.env.PROSPECTOR_API_KEY || 'default';
const CLIENT_TIER = process.env.PROSPECTOR_TIER || 'free';

const server = new McpServer({
  name: "prospector",
  version: "1.0.0",
});

// ── Tool: verify_email ───────────────────────────────────────

server.registerTool(
  "verify_email",
  {
    title: "Verify Email",
    description: "Verify if an email address is valid and deliverable. Performs DNS MX lookup, SMTP handshake (without sending email), catch-all detection, and disposable domain filtering. Returns confidence score (0-100).",
    inputSchema: { email: z.string().email().describe("Email address to verify") },
  },
  async ({ email }) => {
    const q = checkQuota(CLIENT_ID, CLIENT_TIER, 1);
    if (!q.allowed) return { content: [{ type: "text" as const, text: JSON.stringify({ error: 'quota_exceeded', message: `Daily limit reached (${q.limit}/day on ${CLIENT_TIER} tier). Resets at midnight UTC.`, used: q.used, limit: q.limit }) }] };
    const result = await verifyEmail(email);
    recordUsage(CLIENT_ID, 1);
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  }
);

// ── Tool: verify_emails_batch ────────────────────────────────

server.registerTool(
  "verify_emails_batch",
  {
    title: "Verify Emails Batch",
    description: "Verify multiple email addresses in a single batch (max 25). Returns verification status and confidence score for each. Efficient for cleaning outreach lists.",
    inputSchema: { emails: z.array(z.string().email()).max(25).describe("Email addresses to verify (max 25)") },
  },
  async ({ emails }) => {
    const q = checkQuota(CLIENT_ID, CLIENT_TIER, emails.length);
    if (!q.allowed) return { content: [{ type: "text" as const, text: JSON.stringify({ error: 'quota_exceeded', ...q }) }] };
    const results: any[] = [];
    for (let i = 0; i < emails.length; i += 4) {
      const batch = emails.slice(i, i + 4);
      const br = await Promise.all(batch.map(verifyEmail));
      results.push(...br);
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
    return { content: [{ type: "text" as const, text: JSON.stringify({ summary, results }, null, 2) }] };
  }
);

// ── Tool: find_emails ────────────────────────────────────────

server.registerTool(
  "find_emails",
  {
    title: "Find Emails",
    description: "Find email addresses for a business. Scrapes their website for contact info, generates pattern-based candidates from a contact name, and verifies all via SMTP. Hunter.io replacement — no API key needed.",
    inputSchema: {
      domain: z.string().describe('Business domain (e.g. "acmecorp.com")'),
      website_url: z.string().url().optional().describe("Full website URL if different from https://domain"),
      contact_name: z.string().optional().describe('Contact person name for pattern matching (e.g. "Jane Smith")'),
    },
  },
  async ({ domain, website_url, contact_name }) => {
    const url = website_url || `https://${domain}`;
    const mx = await verifyMX(domain);
    if (!mx.valid) return { content: [{ type: "text" as const, text: JSON.stringify({ domain, status: 'invalid_domain', reason: mx.reason, emails: [] }) }] };

    const scraped = await scrapeEmailsFromWebsite(url);
    let candidates: string[] = [];
    if (contact_name) {
      const parts = contact_name.trim().split(/\s+/);
      candidates = generateEmailCandidates(parts[0], parts.length > 1 ? parts[parts.length - 1] : '', domain);
      candidates = candidates.filter(c => !scraped.emails.includes(c));
    } else {
      candidates = ['info', 'hello', 'contact', 'admin', 'office', 'team', 'sales'].map(p => `${p}@${domain}`).filter(c => !scraped.emails.includes(c));
    }

    const allEmails = [...new Set([...scraped.emails, ...candidates])];
    const q = checkQuota(CLIENT_ID, CLIENT_TIER, allEmails.length);
    if (!q.allowed) return { content: [{ type: "text" as const, text: JSON.stringify({ error: 'quota_exceeded', ...q }) }] };

    const verified: any[] = [];
    for (let i = 0; i < allEmails.length; i += 4) {
      const batch = allEmails.slice(i, i + 4);
      const results = await Promise.all(batch.map(verifyEmail));
      verified.push(...results);
      if (i + 4 < allEmails.length) await new Promise(r => setTimeout(r, 500));
    }
    recordUsage(CLIENT_ID, allEmails.length);
    verified.sort((a, b) => (b.score || 0) - (a.score || 0));
    const validEmails = verified.filter(v => v.status === 'valid' || v.status === 'risky');

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({ domain, website: url, mx_host: mx.mx, pages_checked: scraped.pagesChecked, total_verified: verified.length, results: verified, best_email: validEmails[0]?.email || null, confidence: validEmails[0]?.score || 0 }, null, 2),
      }],
    };
  }
);

// ── Tool: check_domain ───────────────────────────────────────

server.registerTool(
  "check_domain",
  {
    title: "Check Domain",
    description: "Quick check if a domain can receive email. Returns MX records and catch-all status. Does not count against quota.",
    inputSchema: { domain: z.string().describe('Domain to check (e.g. "example.com")') },
  },
  async ({ domain }) => {
    const mx = await verifyMX(domain);
    let catchAll = false;
    if (mx.valid) catchAll = await detectCatchAll(domain, mx.mx);
    return { content: [{ type: "text" as const, text: JSON.stringify({ domain, can_receive_email: mx.valid, mx_host: mx.mx || null, all_mx: mx.allMx || [], catch_all: catchAll }) }] };
  }
);

// ── Tool: usage_stats ────────────────────────────────────────

server.registerTool(
  "usage_stats",
  {
    title: "Usage Stats",
    description: "Check your current daily usage quota, remaining verifications, and tier.",
    inputSchema: {},
  },
  async () => {
    const stats = getUsageStats(CLIENT_ID, CLIENT_TIER);
    return { content: [{ type: "text" as const, text: JSON.stringify(stats, null, 2) }] };
  }
);

// ============================================================================
// Express App Setup
// ============================================================================

const app = express();
app.use(express.json());

app.get("/health", (_req: Request, res: Response) => {
  const today = getToday();
  let totalClients = 0, totalVerifications = 0;
  for (const [, rec] of usage) { if (rec.resetDate === today) { totalClients++; totalVerifications += rec.count; } }
  res.status(200).json({ status: "ok", date: today, activeClients: totalClients, totalVerifications });
});

app.post("/mcp", async (req: Request, res: Response) => {
  const startTime = Date.now();
  const body = req.body;
  const method = body?.method || "unknown";
  const params = body?.params;

  if (method === "tools/call") {
    const toolName = params?.name || "unknown";
    logRequest(`tools/call ${chalk.bold(toolName)}`, params?.arguments);
  } else if (method !== "notifications/initialized") {
    logRequest(method, params);
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  let responseBody = "";
  const originalWrite = res.write.bind(res) as typeof res.write;
  const originalEnd = res.end.bind(res) as typeof res.end;

  res.write = function (chunk: unknown, encodingOrCallback?: BufferEncoding | ((error: Error | null | undefined) => void), callback?: (error: Error | null | undefined) => void) {
    if (chunk) responseBody += typeof chunk === "string" ? chunk : Buffer.from(chunk as ArrayBuffer).toString();
    return originalWrite(chunk as string, encodingOrCallback as BufferEncoding, callback);
  };

  res.end = function (chunk?: unknown, encodingOrCallback?: BufferEncoding | (() => void), callback?: () => void) {
    if (chunk) responseBody += typeof chunk === "string" ? chunk : Buffer.from(chunk as ArrayBuffer).toString();
    if (method !== "notifications/initialized") {
      const latency = Date.now() - startTime;
      try {
        const rpcResponse = JSON.parse(responseBody) as { result?: unknown; error?: unknown };
        if (rpcResponse?.error) logError(method, rpcResponse.error, latency);
        else if (method === "tools/call") {
          const content = (rpcResponse?.result as { content?: Array<{ text?: string }> })?.content;
          logResponse(method, content?.[0]?.text, latency);
        } else logResponse(method, null, latency);
      } catch { logResponse(method, null, latency); }
    }
    return originalEnd(chunk as string, encodingOrCallback as BufferEncoding, callback);
  };

  res.on("close", () => { transport.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

// ============================================================================
// Start Server
// ============================================================================

const port = parseInt(process.env.PORT || "8080");
app.listen(port, () => {
  console.log();
  console.log(chalk.bold("Prospector MCP Server running on"), chalk.cyan(`http://localhost:${port}`));
  console.log(`  ${chalk.gray("Health:")} http://localhost:${port}/health`);
  console.log(`  ${chalk.gray("MCP:")}    http://localhost:${port}/mcp`);
  console.log(`  ${chalk.gray("Tools:")}  verify_email, verify_emails_batch, find_emails, check_domain, usage_stats`);
  if (isDev) { console.log(); console.log(chalk.gray("─".repeat(50))); console.log(); }
});
