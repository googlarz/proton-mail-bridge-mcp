# Validation Status

**Audit date:** 2026-03-24  
**Repository:** `anyrxo/protonmail-pro-mcp`  
**Product:** `Proton Mail Bridge MCP`  
**Version:** 3.6.0

## Summary

The repository previously claimed a fully implemented MCP server, but the committed source tree did not match those claims:

- the project did not build
- six imported modules were missing from git
- there was no `CallTool` handler, only tool metadata

That gap has now been closed with a working TypeScript implementation. The `v3.6` layer adds incremental sync, IMAP IDLE-aware refresh, attachment-text indexing, digest/follow-up tooling, and stronger live verification on top of the prior production hardening work:

- SQLite-backed mailbox indexing instead of JSON-only metadata persistence
- incremental sync checkpoints per folder with persisted sync state
- IMAP IDLE-aware change detection for background refresh and diagnostics
- attachment-text extraction into the local search index for text-like files
- inbox digest and follow-up candidate views for assistant-style mailbox triage
- persistent sanitized audit logs with tool-level success/error records
- `*_COMMAND` secret loading in addition to `*_FILE`
- a Claude Desktop config installer script
- CI on Node 20 and 22
- broader unit coverage around the new sync/thread/runtime paths

## Verified In This Audit

- `npm run build` succeeds
- `npm audit` reports zero remaining advisories after upgrading `nodemailer`
- `dist/index.js` imports successfully in Node.js
- `node --test test/*.test.mjs` succeeds
- live Proton Bridge SMTP verification succeeds
- live Proton Bridge IMAP folder listing and message fetch succeed
- persistent local SQLite index write and local search succeed
- incremental second-pass sync and persisted checkpoint coverage succeed
- indexed actionable-thread ranking and normalized thread lookup succeed
- indexed inbox digest and follow-up candidate generation succeed
- live attachment listing, content fetch, and temp-file save succeed against a real mailbox message
- short live IMAP IDLE probe succeeds against Proton Bridge
- live Proton Drafts-folder sync succeeds for reply and compose drafts
- live Bridge smoke coverage succeeds for:
  - indexed-thread-targeted reply draft creation/update and remote Drafts-folder sync against a real inbound message, with actionable-thread coverage reported when available
  - compose draft remote sync, send, and delete
  - forward send
  - reversible thread-level star -> unstar coverage against a real mailbox thread
  - batch attachment save against a real mailbox message
- the Claude Desktop installer helper builds and is covered by unit tests
- the repository now contains concrete source for:
  - SQLite mailbox indexing
  - audit logging and retrieval
  - secret-command based env loading
  - Claude Desktop config installation
  - GitHub Actions CI
- the repository now contains concrete source for:
  - SMTP transport
  - IMAP transport
  - analytics helpers
  - local index persistence
  - background mailbox sync
  - runtime safety policy controls
  - secret-file based env loading
  - local draft persistence
  - Proton Drafts-folder sync
  - normalized label/thread views
  - actionable thread scoring
  - thread-targeted draft workflows
  - batch and thread mailbox actions
  - attachment retrieval/save helpers
  - MCP resource link/read handlers
  - logging
  - MCP tool handlers

## Not Verified In This Audit

These still require deeper live usage over time:

- analytics correctness against a real mailbox
- attachment handling across more MIME variants beyond the verified sample
- long-running index freshness and re-sync behavior across a large active mailbox
- attachment-text extraction across a wider range of MIME variants beyond the verified sample
- destructive-action smoke with an explicitly designated safe mutation email id

## Practical Status

The repository is now in a materially better state than the historical report suggested, but it should be treated as:

- buildable
- inspectable
- live-testable against Proton Bridge
- unit-tested around runtime policy, env config, command/file secret loading, audit persistence, install helpers, background sync, and thread grouping
- incrementally synced and more Claude-useful because it can keep a warmer mailbox index and produce digest/follow-up views
- materially more useful for Claude-style mail workflows than the original repo state
- closer to a day-to-day assistant mailbox connector because it can now triage actionable threads and act on whole threads instead of only single messages

It is now strong for serious self-hosted production-style use, but it still should not be described as fully production-validated until the long-running live account workflows above are exercised over time.
