# Prospector MCP

**B2B email finder and verification — no paid API subscriptions required.**

Prospector is a Model Context Protocol (MCP) server that finds and verifies business email addresses. Unlike Hunter.io, Apollo.io, or Lusha, Prospector does its own DNS/SMTP verification and web scraping. Zero external API costs.

## Why Prospector?

| Feature | Prospector | Hunter.io MCP | Apollo.io MCP | Lusha MCP |
|---------|-----------|---------------|---------------|-----------|
| Self-contained verification | Yes | No (API wrapper) | No (API wrapper) | No (API wrapper) |
| External subscription required | No | $49-399/mo | $49-119/mo | Credits-based |
| Email finding | Yes | Yes | Yes | Bulk lookup only |
| SMTP verification | Yes | Via API | Via API | Via API |
| Catch-all detection | Yes | Via API | No | No |
| Website scraping | Yes | No | No | No |
| Pattern generation | Yes | Yes | No | No |
| Free tier | 50/day | 25/mo | Limited | Limited |
| Tools | 6 | 2 | 9-27 | 2 |
| Open source | Yes | Archived | Community forks | Minimal |

## Quick Start

### With Claude Code

```bash
claude mcp add prospector -- npx prospector-mcp
```

### With Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "prospector": {
      "command": "npx",
      "args": ["prospector-mcp"]
    }
  }
}
```

### With Cursor / Windsurf

Add to your MCP settings:

```json
{
  "prospector": {
    "command": "npx",
    "args": ["prospector-mcp"]
  }
}
```

## Tools

### `verify_email`
Verify if an email address is valid and deliverable. Performs DNS MX lookup, SMTP handshake (without sending email), catch-all detection, and disposable domain filtering. Returns a confidence score (0-100).

```
Input:  { "email": "jane@acmecorp.com" }
Output: { "email": "jane@acmecorp.com", "status": "valid", "score": 95, "mx_host": "aspmx.l.google.com", ... }
```

### `verify_emails_batch`
Verify up to 25 emails in a single request. Efficient for cleaning outreach lists.

```
Input:  { "emails": ["jane@acme.com", "fake@nowhere.xyz"] }
Output: { "summary": { "total": 2, "valid": 1, "invalid": 1 }, "results": [...] }
```

### `find_emails`
Find email addresses for a business. Scrapes their website for contact info, generates pattern-based candidates from a contact name, and SMTP-verifies everything it finds. This is your Hunter.io replacement.

```
Input:  { "domain": "acmecorp.com", "contact_name": "Jane Smith" }
Output: { "best_email": "jane.smith@acmecorp.com", "confidence": 95, "results": [...] }
```

### `check_domain`
Quick check if a domain can receive email. Returns MX records and catch-all status. Does not count against your verification quota.

```
Input:  { "domain": "acmecorp.com" }
Output: { "can_receive_email": true, "mx_host": "aspmx.l.google.com", "catch_all": false }
```

### `usage_stats`
Check your current daily usage quota and remaining verifications.

## How It Works

1. **DNS MX Lookup** — Checks if the domain has mail exchange records
2. **SMTP Handshake** — Connects to the mail server and sends `RCPT TO:` to check if the mailbox exists (no email is sent)
3. **Catch-All Detection** — Tests a random address to detect domains that accept all emails
4. **Web Scraping** — Fetches the business website and contact pages, extracts email addresses and mailto: links
5. **Pattern Generation** — Generates common email patterns (first.last@, flast@, etc.) from a contact name
6. **Confidence Scoring** — Combines all signals into a 0-100 score

## Pricing

Prospector uses a simple daily quota system:

| Tier | Verifications/Day | Price |
|------|-------------------|-------|
| Free | 50 | $0 |
| Pro | 500 | $12/mo |
| Business | 2,000 | $29/mo |

Set your tier via environment variable:

```bash
PROSPECTOR_TIER=pro npx prospector-mcp
```

## HTTP Server (Remote Deployment)

For remote deployment, Prospector includes an HTTP/SSE transport:

```bash
node src/http-server.js
# or
PROSPECTOR_PORT=8080 node src/http-server.js
```

Endpoints:
- `POST /mcp` — MCP Streamable HTTP endpoint
- `GET /health` — Health check with usage stats

## Requirements

- Node.js 18+
- Network access to port 25 (SMTP) for email verification

**Note:** Some hosting providers and corporate networks block outbound port 25. If SMTP verification returns "unknown" for all emails, check your network's firewall rules.

## License

MIT
