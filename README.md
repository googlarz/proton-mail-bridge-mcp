# Proton Mail Bridge MCP

Proton Mail Bridge MCP: professional Proton Mail management with 20+ tools, advanced analytics, and seamless Proton Bridge integration.

Current published GitHub repository: `googlarz/proton-mail-bridge-mcp`

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

Here, "local MCP server" means **this MCP server** itself running on your machine, Claude Desktop host, or another machine you control.

| Capability | Native Gmail connector | Proton Mail Bridge MCP |
| --- | --- | --- |
| Setup | ✅ First-party OAuth inside Claude | 🔧 Requires Proton Bridge plus **this MCP server** running locally |
| Search and read | ✅ Native Claude UX with source citations | ✅ Yes, through IMAP plus local indexing |
| Original-provider links | ✅ Better | 🟡 MCP resource links and locate hints, not true Proton webmail links |
| Native labels and threads | ✅ Gmail-native | 🟡 Reconstructed from IMAP and the local index |
| Send email | ❌ No | ✅ Yes, through Proton Bridge SMTP |
| Draft workflows | ✅ Better first-party UX | ✅ Strong operational control, including remote draft sync |
| Attachment content | 🟡 Limited | ✅ Can fetch content and save files |
| Mailbox actions | 🟡 Limited | ✅ Read, star, move, archive, trash, restore, delete, and batch actions |
| Cross-device Claude availability | ✅ Better | 🟡 Only where this MCP server is installed and running |
| Auth model | ✅ First-party Google auth | 🔧 Local Proton Bridge credentials |

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

## Requirements

Before you start, you need:

1. Node.js 18 or newer.
2. A Proton account.
3. Proton Bridge installed and signed in.
4. About 10 minutes.

You will also need these values from Proton Bridge:

- IMAP host
- IMAP port
- SMTP host
- SMTP port
- username
- Bridge password

For most local Bridge setups, the defaults are:

- IMAP host: `127.0.0.1`
- IMAP port: `1143`
- SMTP host: `127.0.0.1`
- SMTP port: `1025`

## 🚀 Quick Start

### 1. 🔐 Open Proton Bridge

Open Proton Bridge and make sure your account is connected.

In Bridge, open the mailbox details or "Configure email client" view and copy:

- IMAP host and IMAP port
- SMTP host and SMTP port
- username
- Bridge password

Keep Proton Bridge running. Do not close it while using this MCP.

### 2. 📥 Download The Project

There is now a concrete repo rename plan in [RENAME-MIGRATION.md](./RENAME-MIGRATION.md) for moving cleanly from `protonmail-pro-mcp` to `proton-mail-bridge-mcp`.

```bash
git clone https://github.com/googlarz/proton-mail-bridge-mcp.git
cd proton-mail-bridge-mcp
npm install
```

If `npm` does not exist on your machine, install Node.js 18+ first, then run the commands again.

### 3. 🧩 Paste Your Bridge Settings

Open Terminal in the project folder and paste this block.

Replace the example values with your own Bridge values:

```bash
export PROTONMAIL_USERNAME='your-address@proton.me'
export PROTONMAIL_PASSWORD='your-bridge-password'
export PROTONMAIL_IMAP_HOST='127.0.0.1'
export PROTONMAIL_IMAP_PORT='1143'
export PROTONMAIL_IMAP_SECURE='false'
export PROTONMAIL_SMTP_HOST='127.0.0.1'
export PROTONMAIL_SMTP_PORT='1025'
export PROTONMAIL_DATA_DIR="$HOME/.proton-mail-bridge-mcp"
export PROTONMAIL_AUTO_SYNC='true'
export PROTONMAIL_STARTUP_SYNC='true'
export PROTONMAIL_SYNC_INTERVAL_MINUTES='5'
export PROTONMAIL_IDLE_WATCH='true'
export PROTONMAIL_IDLE_MAX_SECONDS='30'
export PROTONMAIL_READ_ONLY='false'
export PROTONMAIL_ALLOW_SEND='true'
export PROTONMAIL_ALLOW_REMOTE_DRAFT_SYNC='true'
export PROTONMAIL_ALLOWED_ACTIONS='mark_read,mark_unread,star,unstar,archive,trash,restore'
```

What these do:

- connect this MCP to Proton Bridge
- store the local mail index under your home folder
- keep the local index refreshed
- allow normal email actions like send, archive, and restore

If you do not want raw secrets in your shell, the server also supports:

- `PROTONMAIL_USERNAME_FILE`
- `PROTONMAIL_PASSWORD_FILE`
- `PROTONMAIL_USERNAME_COMMAND`
- `PROTONMAIL_PASSWORD_COMMAND`

### 4. 🏗️ Build It

```bash
npm run build
```

### 5. ✅ Test The Connection

If you want a quick local verification:

```bash
npm run smoke:bridge
```

That checks the most important real-world path:

- Proton Bridge connection
- IMAP read
- SMTP send
- local indexing
- draft sync
- attachment handling

If you also want destructive mutation coverage, set:

```bash
export PROTONMAIL_SMOKE_ALLOW_MUTATIONS='true'
export PROTONMAIL_SMOKE_MUTATION_EMAIL_ID='INBOX::123'
```

Only do that with a safe disposable message id.

## 🤖 Claude Desktop Setup

If you use Claude Desktop, read this first:

- The "Add custom connector" screen with `Name` and `Remote MCP server URL` is for remote MCP connectors hosted on the internet.
- This repository currently ships a local MCP server that runs on your machine over `stdio`.
- That means there is no URL from this repo that you can paste into that screen today.

So for this project right now:

- use the local install flow below
- do not use the `Remote MCP server URL` field unless you separately deploy a hosted remote version of this server

If you want one-click support for that new connector screen later, the next product step would be either:

- a hosted remote MCP version of Proton Mail Bridge MCP
- or a packaged Claude Desktop extension / MCP Bundle (`.mcpb`)

### Easiest Path For Most Users

1. Open Terminal in the project folder.
2. Paste the Bridge settings from Step 3 above.
3. Run:

```bash
npm run install:claude-desktop
```

4. Restart Claude Desktop.
5. Open Claude and check that the MCP tools are available.

The installer does all of this for you:

- builds the project
- writes a Claude Desktop MCP entry
- uses the default server key `proton-mail-bridge`
- backs up the previous Claude Desktop config if one exists
- copies current `PROTONMAIL_*` and `DEBUG` values unless you pass `--no-env`

Important:

- run the installer in the same Terminal window where you pasted your Bridge settings
- keep Proton Bridge open when using Claude Desktop
- if your Bridge password or ports change later, run the installer again
- this flow is for the local MCP setup, not the remote URL connector screen

### Manual Claude Desktop Config

If you prefer to edit the config yourself, add an entry like this to Claude Desktop's MCP config:

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

### 🛠️ Claude Desktop Tips

- If Claude shows only the "Add custom connector" remote URL dialog, remember: this repo is not a remote URL connector yet.
- Keep Proton Bridge running before starting Claude Desktop.
- If Claude does not see the tools, restart Claude Desktop after installing or editing config.
- If credentials or Bridge ports change, reinstall or update the config.
- If you want safer local storage, prefer `*_FILE` or `*_COMMAND` over raw secrets in config.
- If something still does not work, run `npm run smoke:bridge` in Terminal first. If that fails, Claude Desktop will fail too.

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
