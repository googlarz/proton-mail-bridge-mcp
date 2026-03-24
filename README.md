# Proton Mail Bridge MCP

[![Glama](https://glama.ai/mcp/servers/@anyrxo/protonmail-pro-mcp/badge)](https://glama.ai/mcp/servers/@anyrxo/protonmail-pro-mcp)

Proton Mail Bridge MCP: professional Proton Mail management with 20+ tools, advanced analytics, and seamless Proton Bridge integration.

Current published GitHub repository: `googlarz/proton-mail-bridge-mcp`

Note: Glama is still indexed under the original repository path right now, so the badge above still points to the legacy listing until the new repo is indexed there.

`Proton Mail Bridge MCP` is a production-oriented MCP server for people who want Claude to work with Proton Mail in a way that is actually useful day to day, not just technically connected. It uses Proton Bridge for IMAP and SMTP, adds a local SQLite index for faster follow-up work, and exposes tools for reading, drafting, sending, attachments, and mailbox actions.

## Why This Exists

Claude has a native Gmail connector, but there is no native Proton Mail connector today. This project closes that gap for Proton users.

Where it is strong:

- Real Proton support through Proton Bridge.
- Read plus write operations: drafts, send, reply, forward, archive, trash, restore.
- Attachment content access and file saving.
- Local indexing, thread triage, follow-up views, and background refresh.

Where it is not native:

- It still requires a local MCP server and Proton Bridge.
- It cannot become a first-party Claude connector from inside this repository.
- It cannot produce true Proton webmail deep links from IMAP alone.

## What It Does

- Connects Claude to Proton Mail through Proton Bridge IMAP and SMTP.
- Reads folders, messages, and attachments.
- Searches live mail and locally indexed mail.
- Creates, updates, syncs, and sends drafts.
- Sends email, replies, and forwards.
- Marks read or unread, stars or unstars, moves, archives, trashes, restores, and deletes.
- Builds a local SQLite index with incremental sync checkpoints.
- Watches for mailbox changes with IMAP IDLE-aware refresh.
- Reconstructs normalized labels and threads from IMAP data.
- Generates actionable thread views, inbox digests, and follow-up candidates.
- Emits MCP resource links and structured source metadata for downstream citation-style rendering.

## What It Does Not Do

- It does not bypass Proton Bridge.
Why: Proton Mail does not currently offer a native first-party Claude connector path here; this server depends on the Bridge IMAP/SMTP surface.

- It does not become a native Claude product integration.
Why: first-party auth, citations, and cross-surface connector UX are platform features, not repo features.

- It does not expose Proton-native conversations or labels from a Proton API.
Why: threads and labels are reconstructed from IMAP metadata plus the local index.

- It does not guarantee perfect attachment extraction for every MIME shape.
Why: attachment parsing is broad and live-tested, but MIME edge cases are effectively endless.

- It does not replace long-running product validation.
Why: the code is live-tested, but true production confidence still comes from soak time and real mailbox usage.

## Compared With Claude's Native Gmail Connector

As of March 24, 2026, the practical comparison looks like this:

| Capability | Native Gmail connector | Proton Mail Bridge MCP |
| --- | --- | --- |
| Setup | First-party OAuth inside Claude | Requires Proton Bridge plus a local MCP server |
| Search and read | Native Claude UX with source citations | Yes, through IMAP plus local indexing |
| Original-provider links | Better | Limited to MCP resource links and locate hints |
| Gmail- or Proton-native labels/threads | Gmail-native | Reconstructed from IMAP and local index |
| Send email | No | Yes, through Proton Bridge SMTP |
| Draft workflows | Better first-party UX | Stronger operational control, including remote draft sync |
| Attachment content | Limited | Can fetch content and save files |
| Mailbox actions | Limited | Read, star, move, archive, trash, restore, delete, batch actions |
| Cross-device Claude availability | Better | Only where this MCP server is installed and running |
| Auth model | First-party Google auth | Local Proton Bridge credentials |

What Gmail still does better:

- Native Claude setup and UX.
- Better first-party citations and original-message linking.
- Provider-native labels and threads.
- No local Bridge or local MCP process to manage.

What this project does better:

- Works with Proton Mail.
- Can send mail.
- Can access attachment content.
- Can perform real mailbox actions.
- Can be tuned for power-user and self-hosted workflows.

Important note on Anthropic's Gmail docs: their public pages are slightly inconsistent about draft creation. The stable overlap across the official pages is that Gmail is the better first-party read/search/citation experience, and it does not send on your behalf. See the official Anthropic pages for current details:

- [Use Google Workspace connectors](https://support.claude.com/en/articles/10166901-use-google-workspace-connectors)
- [Gmail integration docs](https://claude.com/docs/connectors/google/gmail)
- [Gmail connector page](https://claude.com/connectors/gmail)

## Requirements

You need:

1. Node.js 18 or newer.
2. A Proton account.
3. Proton Bridge running locally if you want Proton mailbox access.
4. Your Bridge mailbox details:
IMAP host, IMAP port, SMTP host, SMTP port, username, and Bridge password.

## Quick Start

### 1. Get Proton Bridge Running

Open Proton Bridge and make sure your account is connected.

Find these values in Bridge:

- IMAP host and port
- SMTP host and port
- username
- Bridge password

For most local Bridge setups, the defaults are:

- IMAP host: `127.0.0.1`
- IMAP port: `1143`
- SMTP host: `127.0.0.1`
- SMTP port: `1025`

### 2. Clone And Install

There is now a concrete repo rename plan in [RENAME-MIGRATION.md](./RENAME-MIGRATION.md) for moving cleanly from `protonmail-pro-mcp` to `proton-mail-bridge-mcp`.

```bash
git clone https://github.com/googlarz/proton-mail-bridge-mcp.git
cd proton-mail-bridge-mcp
npm install
```

### 3. Set Your Environment

Minimum working Bridge example:

```bash
export PROTONMAIL_USERNAME='your-address@proton.me'
export PROTONMAIL_PASSWORD='your-bridge-password'
export PROTONMAIL_IMAP_HOST='127.0.0.1'
export PROTONMAIL_IMAP_PORT='1143'
export PROTONMAIL_IMAP_SECURE='false'
export PROTONMAIL_SMTP_HOST='127.0.0.1'
export PROTONMAIL_SMTP_PORT='1025'
```

Recommended runtime settings:

```bash
export PROTONMAIL_DATA_DIR="$HOME/.proton-mail-bridge-mcp"
export PROTONMAIL_AUTO_SYNC='true'
export PROTONMAIL_STARTUP_SYNC='true'
export PROTONMAIL_SYNC_INTERVAL_MINUTES='5'
export PROTONMAIL_IDLE_WATCH='true'
export PROTONMAIL_IDLE_MAX_SECONDS='30'
```

Safer production-style settings:

```bash
export PROTONMAIL_READ_ONLY='false'
export PROTONMAIL_ALLOW_SEND='true'
export PROTONMAIL_ALLOW_REMOTE_DRAFT_SYNC='true'
export PROTONMAIL_ALLOWED_ACTIONS='mark_read,mark_unread,star,unstar,archive,trash,restore'
```

If you do not want raw secrets in your shell, the server also supports:

- `PROTONMAIL_USERNAME_FILE`
- `PROTONMAIL_PASSWORD_FILE`
- `PROTONMAIL_USERNAME_COMMAND`
- `PROTONMAIL_PASSWORD_COMMAND`

### 4. Build

```bash
npm run build
```

### 5. Optional: Run A Smoke Test

This is the fastest way to verify that Bridge, IMAP, SMTP, and the local index can all work together:

```bash
npm run smoke:bridge
```

For destructive mutation coverage, set:

```bash
export PROTONMAIL_SMOKE_ALLOW_MUTATIONS='true'
export PROTONMAIL_SMOKE_MUTATION_EMAIL_ID='INBOX::123'
```

Only do that with a safe disposable message id.

## Claude Desktop Setup

### Easiest Path

After your environment variables are set:

```bash
npm run install:claude-desktop
```

That installer:

- builds the project
- writes a Claude Desktop MCP entry
- uses the default server key `proton-mail-bridge`
- backs up the previous Claude Desktop config if one exists
- copies current `PROTONMAIL_*` and `DEBUG` values unless you pass `--no-env`

Then restart Claude Desktop.

### Manual Claude Desktop Config

If you prefer to edit the config yourself, add an entry like this:

```json
{
  "mcpServers": {
    "proton-mail-bridge": {
      "command": "node",
      "args": ["/absolute/path/to/proton-mail-bridge-mcp/dist/index.js"],
      "cwd": "/absolute/path/to/proton-mail-bridge-mcp",
      "env": {
        "PROTONMAIL_USERNAME": "your-address@proton.me",
        "PROTONMAIL_PASSWORD": "your-bridge-password",
        "PROTONMAIL_IMAP_HOST": "127.0.0.1",
        "PROTONMAIL_IMAP_PORT": "1143",
        "PROTONMAIL_IMAP_SECURE": "false",
        "PROTONMAIL_SMTP_HOST": "127.0.0.1",
        "PROTONMAIL_SMTP_PORT": "1025"
      }
    }
  }
}
```

### Claude Desktop Tips

- Keep Proton Bridge running before starting Claude Desktop.
- If Claude does not see the tools, restart Claude Desktop after installing or editing config.
- If credentials or Bridge ports change, reinstall or update the config.
- If you want safer local storage, prefer `*_FILE` or `*_COMMAND` over raw secrets in config.

## Tool Surface

### Send

- `send_email`
- `send_test_email`
- `reply_to_email`
- `forward_email`

### Drafts

- `create_draft`
- `create_reply_draft`
- `create_forward_draft`
- `create_thread_reply_draft`
- `list_drafts`
- `list_remote_drafts`
- `get_draft`
- `update_draft`
- `sync_draft_to_remote`
- `send_draft`
- `delete_draft`

### Read

- `get_emails`
- `get_email_by_id`
- `search_emails`
- `list_attachments`
- `get_attachment_content`
- `save_attachments`
- `save_attachment`

### Mailbox And Triage

- `get_folders`
- `sync_folders`
- `get_labels`
- `get_threads`
- `get_thread_by_id`
- `get_actionable_threads`
- `get_inbox_digest`
- `get_follow_up_candidates`

### Actions

- `mark_email_read`
- `star_email`
- `move_email`
- `archive_email`
- `trash_email`
- `restore_email`
- `delete_email`
- `batch_email_action`
- `apply_thread_action`

### Diagnostics And Maintenance

- `get_connection_status`
- `get_runtime_status`
- `run_doctor`
- `get_audit_logs`
- `run_background_sync`
- `wait_for_mailbox_changes`
- `sync_emails`
- `get_index_status`
- `search_indexed_emails`
- `clear_cache`
- `clear_index`
- `get_logs`

## Operational Notes

- `get_emails` and `search_emails` return a composite `emailId`. Use that same value for reads and mailbox actions.
- Draft sync is best-effort. If remote draft sync fails, the local draft is still preserved.
- The local index lives at `PROTONMAIL_DATA_DIR/mail-index.sqlite`.
- Audit logs live at `PROTONMAIL_DATA_DIR/audit.log`.
- Background sync and IMAP IDLE can keep the local index warm, but they still depend on Bridge staying up.
- `run_doctor` is the quickest tool-level health check once the server is running.

## Validation Snapshot

Current repository verification includes:

- `npm run build`
- `npm test`
- `npm audit --omit=dev`
- live Proton Bridge SMTP verification
- live Proton Bridge IMAP verification
- live incremental sync verification
- live attachment read and save verification
- live remote draft sync verification
- live IDLE probe verification
- live disposable-message mutation coverage against appended `INBOX` fixtures

Still not fully validated:

- long-running soak behavior over days
- wider MIME edge-case attachment coverage
- exact Proton-native thread semantics, because IMAP reconstruction is still an approximation

## License

MIT
