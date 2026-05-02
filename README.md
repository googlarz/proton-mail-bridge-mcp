```
  ____  ____   ___ _____ ___  _   _   __  __    _    ___ _
 |  _ \|  _ \ / _ \_   _/ _ \| \ | | |  \/  |  / \  |_ _| |
 | |_) | |_) | | | || || | | |  \| | | |\/| | / _ \  | || |
 |  __/|  _ <| |_| || || |_| | |\  | | |  | |/ ___ \ | || |___
 |_|   |_| \_\\___/ |_| \___/|_| \_| |_|  |_/_/   \_\___|_____|
  Bridge Client  ·  CLI + Claude Desktop MCP for Proton Mail
```

# Proton Mail Bridge Client

A full-featured CLI and Claude Desktop MCP for Proton Mail, built on top of Proton Bridge.

## About

Proton Mail Bridge Client gives you two ways to use Proton Mail programmatically:

**CLI** — a terminal client with complete parity to the MCP surface. Read, search, send, draft, archive, manage folders, triage threads, and run diagnostics — all from the command line. Body can be piped via stdin. Output is either human-readable or `--json`.

**MCP server** — the same capabilities exposed as a Model Context Protocol server so Claude Desktop can read and manage your Proton Mail in any chat, on the same machine where Proton Bridge is running.

Both surfaces share the same backend: Proton Bridge IMAP and SMTP, a local SQLite index, and an audit log. No hosted relay, no remote URL, no cloud dependency beyond your own Proton account.

## Prerequisites

- Node.js 18+
- [Proton Bridge](https://proton.me/mail/bridge) installed and signed in
- From Bridge: IMAP host/port, SMTP host/port, username, Bridge password

Default local Bridge addresses: IMAP `127.0.0.1:1143`, SMTP `127.0.0.1:1025`

## Install

```bash
git clone https://github.com/googlarz/proton-mail-bridge-client.git
cd proton-mail-bridge-client
npm install
npm run build
```

After install, the `proton-mail-bridge-client` (and `proton-mail-bridge`) binary is available from the repo.

For a system-wide install: `npm install -g .`

## CLI

```bash
proton-mail-bridge-client <command> [options]
```

All commands support `--json` for machine-readable output.

### Read

```bash
proton-mail-bridge-client emails --folder INBOX --limit 25
proton-mail-bridge-client read INBOX::25642
proton-mail-bridge-client search "invoice" --limit 10
proton-mail-bridge-client search --live --from openai.com
proton-mail-bridge-client attachments INBOX::25642
```

### Triage

```bash
proton-mail-bridge-client digest
proton-mail-bridge-client threads "quarterly review"
proton-mail-bridge-client actionable
proton-mail-bridge-client followups
proton-mail-bridge-client thread-brief <threadId>
proton-mail-bridge-client document-threads --category invoice
proton-mail-bridge-client meeting-context alice@example.com
```

### Compose & send

```bash
proton-mail-bridge-client send --to bob@example.com --subject "Hey" --body "Hello"
echo "Hello" | proton-mail-bridge-client send --to bob@example.com --subject "Hey"
proton-mail-bridge-client reply INBOX::25642 --body "On it."
proton-mail-bridge-client reply INBOX::25642 --reply-all --body "On it."
proton-mail-bridge-client forward INBOX::25642 --to carol@example.com
```

### Mailbox actions

```bash
proton-mail-bridge-client move INBOX::25642 Folders/Archive
proton-mail-bridge-client archive INBOX::25642
proton-mail-bridge-client trash INBOX::25642
proton-mail-bridge-client restore Trash::25642
proton-mail-bridge-client mark-read INBOX::25642
proton-mail-bridge-client mark-read INBOX::25642 --unread
proton-mail-bridge-client star INBOX::25642
proton-mail-bridge-client delete INBOX::25642
proton-mail-bridge-client batch archive INBOX::100,INBOX::101,INBOX::102
proton-mail-bridge-client thread-action <threadId> archive
```

### Folders

```bash
proton-mail-bridge-client folders
proton-mail-bridge-client create-folder Folders/Receipts
proton-mail-bridge-client rename-folder Folders/Receipts Folders/Bills
proton-mail-bridge-client delete-folder Folders/Bills
```

### Drafts

```bash
proton-mail-bridge-client drafts
proton-mail-bridge-client draft-create --to bob@example.com --subject "Draft" --body "..."
proton-mail-bridge-client draft-read <id>
proton-mail-bridge-client draft-update <id> --subject "Updated subject"
proton-mail-bridge-client draft-reply INBOX::25642 --body "Will do."
proton-mail-bridge-client draft-forward INBOX::25642 --to carol@example.com
proton-mail-bridge-client draft-sync <id>
proton-mail-bridge-client draft-send <id>
proton-mail-bridge-client draft-delete <id>
proton-mail-bridge-client remote-drafts
```

### Analytics & diagnostics

```bash
proton-mail-bridge-client stats
proton-mail-bridge-client analytics
proton-mail-bridge-client contacts
proton-mail-bridge-client volume-trends --days 14
proton-mail-bridge-client watch --timeout 30
proton-mail-bridge-client test-email you@example.com
proton-mail-bridge-client doctor
proton-mail-bridge-client status
proton-mail-bridge-client sync --folder INBOX --limit 150
```

### MCP tool passthrough

Any MCP tool is also callable directly from the CLI:

```bash
proton-mail-bridge-client tools
proton-mail-bridge-client tool get_connection_status --json
proton-mail-bridge-client tool search_indexed_emails --args '{"query":"invoice","limit":3}'
```

## Environment

The CLI and MCP server both read the same environment variables:

```bash
export PROTONMAIL_USERNAME='you@proton.me'
export PROTONMAIL_PASSWORD='your-bridge-password'
export PROTONMAIL_IMAP_HOST='127.0.0.1'
export PROTONMAIL_IMAP_PORT='1143'
export PROTONMAIL_IMAP_SECURE='false'
export PROTONMAIL_SMTP_HOST='127.0.0.1'
export PROTONMAIL_SMTP_PORT='1025'
export PROTONMAIL_DATA_DIR="$HOME/.proton-mail-bridge-client"
```

Optional secrets via file or command (avoids raw credentials in shell):

```bash
export PROTONMAIL_USERNAME_FILE='/path/to/user.txt'
export PROTONMAIL_PASSWORD_FILE='/path/to/pass.txt'
# or
export PROTONMAIL_USERNAME_COMMAND='pass proton/username'
export PROTONMAIL_PASSWORD_COMMAND='pass proton/password'
```

Full runtime flags:

```bash
export PROTONMAIL_READ_ONLY='false'
export PROTONMAIL_ALLOW_SEND='true'
export PROTONMAIL_ALLOW_REMOTE_DRAFT_SYNC='true'
export PROTONMAIL_ALLOWED_ACTIONS='mark_read,mark_unread,star,unstar,archive,trash,restore'
export PROTONMAIL_AUTO_SYNC='true'
export PROTONMAIL_STARTUP_SYNC='true'
export PROTONMAIL_SYNC_INTERVAL_MINUTES='5'
export PROTONMAIL_IDLE_WATCH='true'
export PROTONMAIL_IDLE_MAX_SECONDS='30'
```

## Claude Desktop Setup

To use Proton Mail Bridge Client with Claude Desktop, run the guided wizard:

```bash
npm run setup:claude-desktop
```

This will:

- check your local Bridge ports
- ask for your Bridge username and password
- build the project
- install a stable machine-wide runtime
- write the Claude Desktop MCP config entry

After setup: restart Claude Desktop, keep Proton Bridge open, then check `+` → `Connectors` → `proton-mail-bridge`.

The runtime is installed at:

- macOS: `~/Library/Application Support/Proton Mail Bridge Client`
- Linux: `~/.local/share/proton-mail-bridge-client`
- Windows: `%APPDATA%\Proton Mail Bridge Client`

### Updating

```bash
git pull
npm run update:claude-desktop
```

### Manual Claude Desktop config

```json
{
  "mcpServers": {
    "proton-mail-bridge": {
      "command": "node",
      "args": ["/path/to/runtime/dist/index.js"],
      "cwd": "/path/to/runtime",
      "env": {
        "PROTONMAIL_USERNAME": "you@proton.me",
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

### macOS note

On macOS, `better-sqlite3` must be a native binary built for the current machine. The installer handles this automatically. If you restore from another environment or see a native-module crash, run `npm run update:claude-desktop`.

## Trust & Safety

- Runs entirely locally — no hosted relay, no remote URL.
- Talks to Proton Mail only through Proton Bridge on your own machine.
- `PROTONMAIL_READ_ONLY=true` disables all write operations.
- `PROTONMAIL_ALLOW_SEND=false` disables SMTP sends without affecting other writes.
- `PROTONMAIL_ALLOWED_ACTIONS` controls which mailbox mutations are permitted.
- `batch_email_action` and `apply_thread_action` both support `dryRun: true`.
- Supports `*_FILE` and `*_COMMAND` secrets so raw credentials never appear in config or shell history.
- System folders (INBOX, Sent, Trash, Spam, Archive, All Mail) are guarded against accidental deletion.

## Compared With Claude's Native Gmail Connector

| Capability | Gmail connector | Proton Mail Bridge Client |
|---|---|---|
| Setup | First-party OAuth | Requires Proton Bridge + this client |
| Search and read | Native Claude UX | IMAP + local index |
| Send email | No | Yes |
| Draft workflows | Better first-party UX | Full control incl. remote draft sync |
| Attachment content | Limited | Fetch and save |
| Mailbox actions | Limited | Full (star, move, archive, trash, restore, delete, batch) |
| Folder management | No | Yes (create, rename, delete) |
| CLI access | No | Full parity with MCP |
| Original message links | Better | MCP resource links only |
| Native threads/labels | Gmail-native | Reconstructed from IMAP |

## Tool Surface

### Send
`send_email` · `send_test_email` · `reply_to_email` · `forward_email`

### Drafts
`create_draft` · `create_reply_draft` · `create_forward_draft` · `create_thread_reply_draft` · `list_drafts` · `list_remote_drafts` · `get_draft` · `update_draft` · `sync_draft_to_remote` · `send_draft` · `delete_draft`

### Read
`get_emails` · `get_email_by_id` · `search_emails` · `list_attachments` · `get_attachment_content` · `save_attachments` · `save_attachment`

### Triage
`get_folders` · `sync_folders` · `get_labels` · `get_threads` · `get_thread_by_id` · `get_thread_brief` · `get_actionable_threads` · `get_inbox_digest` · `get_follow_up_candidates` · `find_document_threads` · `prepare_meeting_context`

### Actions
`mark_email_read` · `star_email` · `move_email` · `archive_email` · `trash_email` · `restore_email` · `delete_email` · `batch_email_action` · `apply_thread_action`

### Folder management
`create_folder` · `rename_folder` · `delete_folder`

### Analytics
`get_email_stats` · `get_email_analytics` · `get_contacts` · `get_volume_trends`

### Diagnostics
`get_connection_status` · `get_runtime_status` · `run_doctor` · `get_audit_logs` · `run_background_sync` · `wait_for_mailbox_changes` · `sync_emails` · `get_index_status` · `search_indexed_emails` · `clear_cache` · `clear_index` · `get_logs`

## Operational Notes

- `get_emails` and `search_emails` return a composite `emailId` — use it for reads and actions.
- The local index lives at `PROTONMAIL_DATA_DIR/mail-index.sqlite`.
- Audit logs live at `PROTONMAIL_DATA_DIR/audit.log`.
- Background sync and IMAP IDLE keep the index warm but depend on Bridge staying up.
- `search_indexed_emails` supports `from:`, `to:`, `subject:`, `label:`, `domain:` shortcuts.
- Draft sync is best-effort — local draft is always preserved even if remote sync fails.

## License

MIT
