// ============================================================
// Prospector — Email Discovery & Verification Engine
// ============================================================
// Self-contained email finding and verification. No paid APIs.
// Uses DNS MX lookups, SMTP handshake verification, web scraping,
// and pattern-based email generation.
// ============================================================

import dns from 'dns/promises';
import net from 'net';

// ── Email Pattern Generator ──────────────────────────────────

const COMMON_PATTERNS = [
  (f, l, d) => `${f}@${d}`,
  (f, l, d) => `${f}.${l}@${d}`,
  (f, l, d) => `${f}${l}@${d}`,
  (f, l, d) => `${f[0]}${l}@${d}`,
  (f, l, d) => `${f[0]}.${l}@${d}`,
  (f, l, d) => `${f}.${l[0]}@${d}`,
  (f, l, d) => `${f}${l[0]}@${d}`,
  (f, l, d) => `${l}.${f}@${d}`,
  (f, l, d) => `${l}${f}@${d}`,
  (f, l, d) => `${l}@${d}`,
  (f, l, d) => `${f}_${l}@${d}`,
  (f, l, d) => `${f}-${l}@${d}`,
];

const GENERIC_PREFIXES = [
  'info', 'hello', 'contact', 'admin', 'office', 'team',
  'support', 'sales', 'enquiries', 'inquiries', 'mail',
];

export function generateEmailCandidates(firstName, lastName, domain) {
  const candidates = new Set();
  const f = firstName?.toLowerCase().trim();
  const l = lastName?.toLowerCase().trim();

  if (f && l) {
    for (const pattern of COMMON_PATTERNS) {
      try {
        candidates.add(pattern(f, l, domain));
      } catch { /* skip patterns that fail */ }
    }
  } else if (f) {
    candidates.add(`${f}@${domain}`);
  }

  for (const prefix of GENERIC_PREFIXES) {
    candidates.add(`${prefix}@${domain}`);
  }

  return [...candidates];
}

// ── DNS MX Verification ─────────────────────────────────────

export async function verifyMX(domain) {
  try {
    const records = await dns.resolveMx(domain);
    if (!records || records.length === 0) {
      return { valid: false, reason: 'no_mx_records' };
    }
    records.sort((a, b) => a.priority - b.priority);
    return {
      valid: true,
      mx: records[0].exchange,
      allMx: records.map(r => ({ host: r.exchange, priority: r.priority })),
    };
  } catch (err) {
    if (err.code === 'ENOTFOUND' || err.code === 'ENODATA') {
      return { valid: false, reason: 'domain_not_found' };
    }
    return { valid: false, reason: `dns_error: ${err.code || err.message}` };
  }
}

// ── SMTP Verification ────────────────────────────────────────
// Connects to MX server and checks if RCPT TO is accepted.
// Does NOT send any email.

export async function verifySMTP(email, mxHost, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let step = 0;
    let resolved = false;

    const done = (result) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };

    const timer = setTimeout(() => done({ valid: 'unknown', reason: 'timeout', code: null }), timeoutMs);

    socket.on('error', (err) => done({ valid: 'unknown', reason: 'connection_error', code: err.code }));
    socket.on('close', () => done({ valid: 'unknown', reason: 'connection_closed', code: null }));

    socket.on('data', (data) => {
      const response = data.toString();
      const code = parseInt(response.slice(0, 3));

      if (step === 0 && code === 220) {
        step = 1;
        socket.write('HELO prospector.local\r\n');
      } else if (step === 1 && code === 250) {
        step = 2;
        socket.write('MAIL FROM:<verify@prospector.local>\r\n');
      } else if (step === 2 && code === 250) {
        step = 3;
        socket.write(`RCPT TO:<${email}>\r\n`);
      } else if (step === 3) {
        if (code === 250 || code === 251) {
          done({ valid: true, reason: 'accepted', code });
        } else if (code === 550 || code === 551 || code === 552 || code === 553 || code === 554) {
          done({ valid: false, reason: 'rejected', code });
        } else if (code === 450 || code === 451 || code === 452) {
          done({ valid: 'unknown', reason: 'temporary_error', code });
        } else {
          done({ valid: 'unknown', reason: `smtp_${code}`, code });
        }
        socket.write('QUIT\r\n');
      } else if (code >= 500) {
        done({ valid: 'unknown', reason: `smtp_error_${code}`, code });
      }
    });

    socket.connect(25, mxHost);
  });
}

// ── Catch-All Detection ──────────────────────────────────────

export async function detectCatchAll(domain, mxHost) {
  const random = `xq7z9-nonexistent-${Date.now()}@${domain}`;
  const result = await verifySMTP(random, mxHost, 8000);
  return result.valid === true;
}

// ── Full Email Verification Pipeline ─────────────────────────

const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com', 'guerrillamail.com', 'tempmail.com', 'throwaway.email',
  'yopmail.com', 'sharklasers.com', 'grr.la', 'temp-mail.org',
  'dispostable.com', 'maildrop.cc', 'guerrillamail.info', 'trashmail.com',
  'fakeinbox.com', 'mailnesia.com', 'guerrillamailblock.com', 'tempail.com',
]);

const FREE_EMAIL_PROVIDERS = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com',
  'icloud.com', 'mail.com', 'protonmail.com', 'zoho.com', 'live.com',
  'msn.com', 'ymail.com', 'gmx.com', 'fastmail.com',
]);

export async function verifyEmail(email) {
  // Format validation
  const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  if (!emailRegex.test(email)) {
    return { email, status: 'invalid', reason: 'bad_format', score: 0 };
  }

  const [localPart, domain] = email.split('@');

  // Disposable check
  if (DISPOSABLE_DOMAINS.has(domain)) {
    return { email, status: 'invalid', reason: 'disposable_domain', score: 0 };
  }

  // Free provider flag
  const isFreeProvider = FREE_EMAIL_PROVIDERS.has(domain);

  // DNS MX lookup
  const mx = await verifyMX(domain);
  if (!mx.valid) {
    return { email, status: 'invalid', reason: mx.reason, domain, score: 0 };
  }

  // SMTP verification
  try {
    const smtp = await verifySMTP(email, mx.mx);

    if (smtp.valid === false) {
      return {
        email, status: 'invalid', reason: 'mailbox_not_found',
        domain, mx_host: mx.mx, smtp_code: smtp.code, score: 0,
      };
    }

    if (smtp.valid === true) {
      // Catch-all detection
      const catchAll = await detectCatchAll(domain, mx.mx);
      const score = catchAll ? 50 : (isFreeProvider ? 80 : 95);

      return {
        email,
        status: catchAll ? 'risky' : 'valid',
        reason: catchAll ? 'catch_all_domain' : 'verified',
        domain,
        mx_host: mx.mx,
        catch_all: catchAll,
        free_provider: isFreeProvider,
        score,
      };
    }

    // Unknown result
    return {
      email, status: 'unknown', reason: smtp.reason,
      domain, mx_host: mx.mx, smtp_code: smtp.code, score: 30,
    };
  } catch {
    return {
      email, status: 'unknown', reason: 'smtp_check_failed',
      domain, mx_host: mx.mx, score: 20,
    };
  }
}

// ── Website Email Scraper ────────────────────────────────────

export async function scrapeEmailsFromWebsite(websiteUrl) {
  const emails = new Set();
  const pagesChecked = [];

  // Domains to ignore in scraped emails
  const IGNORE_DOMAINS = new Set([
    'example.com', 'sentry.io', 'wixpress.com', 'schema.org',
    'w3.org', 'wordpress.org', 'googleapis.com', 'cloudflare.com',
    'gravatar.com', 'facebook.com', 'twitter.com',
  ]);

  const FILE_EXTENSIONS = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.svg', '.css', '.js',
    '.woff', '.woff2', '.ttf', '.eot', '.ico', '.webp',
  ]);

  function isValidEmail(email) {
    const domain = email.split('@')[1];
    if (!domain) return false;
    if (IGNORE_DOMAINS.has(domain)) return false;
    if (FILE_EXTENSIONS.has('.' + domain.split('.').pop())) return false;
    for (const ext of FILE_EXTENSIONS) {
      if (email.endsWith(ext)) return false;
    }
    return true;
  }

  async function fetchPage(url) {
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Prospector/1.0; +https://github.com/JosieBot26/prospector-mcp-email-finder)' },
        signal: AbortSignal.timeout(12000),
        redirect: 'follow',
      });
      if (!response.ok) return null;
      return await response.text();
    } catch {
      return null;
    }
  }

  function extractEmails(html) {
    const found = new Set();
    // Standard email pattern
    const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
    for (const match of html.matchAll(emailRegex)) {
      const email = match[0].toLowerCase();
      if (isValidEmail(email)) found.add(email);
    }
    // mailto: links
    const mailtoRegex = /mailto:([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/gi;
    for (const match of html.matchAll(mailtoRegex)) {
      const email = match[1].toLowerCase();
      if (isValidEmail(email)) found.add(email);
    }
    return found;
  }

  try {
    // Fetch main page
    const html = await fetchPage(websiteUrl);
    if (!html) return { emails: [], pagesChecked: [], error: 'Could not fetch website' };
    pagesChecked.push(websiteUrl);

    for (const email of extractEmails(html)) {
      emails.add(email);
    }

    // Find contact/about page links
    const baseUrl = new URL(websiteUrl).origin;
    const contactPaths = new Set(['/contact', '/contact-us', '/about', '/about-us', '/connect', '/info', '/reach-out']);

    // Extract from page links
    const linkRegex = /href=["']([^"']*(?:contact|about|connect|reach|info|team)[^"']*)/gi;
    for (const match of html.matchAll(linkRegex)) {
      let path = match[1];
      if (path.startsWith('/')) contactPaths.add(path.split('?')[0].split('#')[0]);
      else if (path.startsWith('http')) {
        try {
          const url = new URL(path);
          if (url.origin === baseUrl) contactPaths.add(url.pathname);
        } catch { /* skip */ }
      }
    }

    // Check contact pages (limit to 4)
    let checked = 0;
    for (const contactPath of contactPaths) {
      if (checked >= 4) break;
      const contactUrl = contactPath.startsWith('http') ? contactPath : baseUrl + contactPath;
      if (pagesChecked.includes(contactUrl)) continue;

      const contactHtml = await fetchPage(contactUrl);
      if (contactHtml) {
        pagesChecked.push(contactUrl);
        checked++;
        for (const email of extractEmails(contactHtml)) {
          emails.add(email);
        }
      }
    }
  } catch (err) {
    return { emails: [...emails], pagesChecked, error: err.message };
  }

  return { emails: [...emails], pagesChecked };
}
