# Proton Mail Bridge MCP

Proton Mail Bridge MCP: professional Proton Mail management with 20+ tools, advanced analytics, and seamless Proton Bridge integration.

Current published GitHub repository: `googlarz/proton-mail-bridge-mcp`

If you use Claude Desktop and Proton Mail, this project gives Claude a practical way to work with your Proton mailbox through Proton Bridge.

The easiest way to think about setup is:

1. install `Proton Mail Bridge MCP` on your computer
2. connect it to Claude Desktop

You do not need to understand MCP internals to use it. If Proton Bridge is already working on your machine, the normal Claude Desktop setup is only a few steps.

## Why This Exists

Claude has a native Gmail connector, but there is no native Proton Mail connector today. This project closes that gap for Proton users.

I built it after `protonmail-pro-mcp` showed there was real demand for this idea, but I wanted a version that was more complete, better tested, and easier to use day to day.

What it is good at:

- Real Proton support through Proton Bridge.
- Read plus write operations: drafts, send, reply, forward, archive, trash, restore.
- Attachment content access and file saving.
- Local indexing, thread triage, follow-up views, and background refresh.

What to expect:

- It runs locally on your machine alongside Proton Bridge.
- It plugs into Claude Desktop, but it is not a first-party Claude connector.
- Source links come from the MCP layer, not native Proton webmail links.

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

## Good To Know

- It uses Proton Bridge.
Why: this project connects through the local IMAP and SMTP access that Proton Bridge provides.

- It runs locally.
Why: Proton Bridge normally runs on your own machine, so this MCP server is designed to run locally too.

- Threads and labels are reconstructed from IMAP data.
Why: Proton-native thread and label objects are not available here through a first-party Claude connector path.

- Attachment handling is broad, but not magic.
Why: the common cases work well, but email MIME formats can be messy across different senders and clients.

## Before You Start

You will need:

1. Claude Desktop
2. Node.js 18 or newer
3. A Proton account
4. Proton Bridge installed and signed in
5. About 10 minutes

From Proton Bridge, you will need:

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

## 🚀 Setup Overview

Setup has two parts:

1. install the local MCP server
2. connect it to Claude Desktop

The normal path is the guided setup wizard. The manual path is only for people who want more control.

## Part 1: Install Proton Mail Bridge MCP

### 1. 🔐 Open Proton Bridge

Open Proton Bridge and make sure your account is connected.

In Bridge, open the mailbox details or "Configure email client" view and copy:

- IMAP host and IMAP port
- SMTP host and SMTP port
- username
- Bridge password

Keep Proton Bridge running. Do not close it while using this MCP.

### 2. 📥 Download The Project

```bash
git clone https://github.com/googlarz/proton-mail-bridge-mcp.git
cd proton-mail-bridge-mcp
npm install
```

If `npm` does not exist on your machine, install Node.js 18+ first, then run the commands again.

At this point, the MCP server files are on your computer and ready for the Claude Desktop step.

## Part 2: Connect It To Claude Desktop

### 3. 🪄 Run The Claude Desktop Setup Wizard

```bash
npm run setup:claude-desktop
```

The wizard does the normal Claude Desktop install for you:

- checks the standard Proton Bridge local ports
- asks for your Proton Bridge username and Bridge password
- uses the standard local Bridge addresses unless you override them
- writes the Claude Desktop MCP entry automatically
- stores the `PROTONMAIL_*` values inside that local Claude Desktop config
- backs up the old Claude Desktop config before changing it

### 4. 🔁 Restart Claude Desktop

After the wizard finishes:

- restart Claude Desktop
- keep Proton Bridge open
- open Claude and confirm the Proton Mail Bridge MCP tools appear

## 🤖 Claude Desktop Setup

If you already have Claude Desktop open, this is the one thing to know first:

- Claude Desktop also supports remote connectors that ask for a URL.
- This project is not that kind of connector.
- It works locally, because Proton Bridge also works locally on your machine.
- So the right setup here is the local Claude Desktop install flow, not the remote URL box.

That means the supported Claude Desktop path in `v3.7` is:

- `npm run setup:claude-desktop` for the guided zero-manual-config flow
- `npm run install:claude-desktop` for env-driven or automated installs
- the `.mcpb` local extension track documented in [CLAUDE-DESKTOP-PACKAGING.md](./CLAUDE-DESKTOP-PACKAGING.md)

### Zero-Manual-Config Path For Bridge Users

1. Open Terminal in the project folder.
2. Run:

```bash
npm run setup:claude-desktop
```

3. Answer the prompts for:
   - your Proton Bridge username
   - your Proton Bridge password
   - whether you want to use the standard local Bridge ports
   - where you want the local data stored
4. Restart Claude Desktop.
5. Open Claude and check that the Proton Mail Bridge MCP tools are available.

This is the easiest path because it avoids manual JSON edits and avoids manual environment-variable setup.

### What `npm run install:claude-desktop` Is For

`npm run install:claude-desktop` is for Claude Desktop.

More specifically, it is the advanced installer that registers this MCP server inside Claude Desktop.

Use it when:

- you want a scriptable install
- you already manage your own `PROTONMAIL_*` environment variables
- you do not want to use the interactive wizard

### Advanced Local Install

If you prefer to control the env yourself, or if you want a more scriptable setup, use the installer command below.

First, export your Bridge values:

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

Then run:

```bash
npm run install:claude-desktop
```

That installer:

- builds the project
- writes a Claude Desktop MCP entry
- uses the default server key `proton-mail-bridge`
- backs up the previous Claude Desktop config if one exists
- copies current `PROTONMAIL_*` and `DEBUG` values unless you pass `--no-env`

If you do not want raw secrets in your shell or config, the server also supports:

- `PROTONMAIL_USERNAME_FILE`
- `PROTONMAIL_PASSWORD_FILE`
- `PROTONMAIL_USERNAME_COMMAND`
- `PROTONMAIL_PASSWORD_COMMAND`

### Optional Local Smoke Test

If you want a real end-to-end check after install:

```bash
npm run smoke:bridge
```

That checks:

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

Important:

- run the installer in the same Terminal window where you exported your Bridge settings
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
