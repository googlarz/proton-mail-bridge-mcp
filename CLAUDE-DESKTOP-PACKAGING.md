# Claude Desktop Packaging

`Proton Mail Bridge MCP` is local-first by design.

That matters because Proton Bridge usually runs on your machine and exposes IMAP and SMTP on local addresses such as `127.0.0.1:1143` and `127.0.0.1:1025`. This MCP server talks to that local Bridge process, so the safest and simplest supported Claude Desktop setup is also local.

## What Works Today

### 1. Zero-manual-config local setup

For most users, the supported path is:

```bash
npm run setup:claude-desktop
```

That wizard:

- asks for your Proton Bridge username and Bridge password
- assumes the standard local Bridge ports unless you override them
- installs a stable local runtime copy for Claude Desktop outside your repo checkout
- writes a `proton-mail-bridge` MCP entry into Claude Desktop's local config
- stores the matching `PROTONMAIL_*` values in that config
- backs up any previous Claude Desktop config before changing it

### 2. Power-user local install

If you already manage your own env vars or secret files, use:

```bash
npm run install:claude-desktop
```

That keeps the same local-first `stdio` model, but lets you drive installation from your own shell or automation.

In both cases, Claude Desktop ends up pointing at a stable local runtime on the machine, not at the temporary folder where you happened to run the installer.

## Why There Is Still No Remote URL

Claude Desktop's `Remote MCP server URL` field expects a hosted remote MCP endpoint, usually reachable over HTTPS.

This project does not ship that by default because:

- Proton Bridge is usually local, not public
- this MCP server currently runs locally over `stdio`
- a pasted remote URL would need a different architecture, not just a different README

In other words, the current product is:

- local Proton Bridge
- local MCP server
- local Claude Desktop config

That is why the local setup flow is the correct path today.

## MCP Bundle (`.mcpb`) Track

The next distribution layer is an MCP Bundle, not a remote URL.

Why this is the right direction:

- it keeps the local security model
- it matches Anthropic's local Desktop extension path
- it reduces setup friction without moving Proton Bridge off the user's machine

## `.mcpb` Packaging Checklist

1. Add bundle manifest, icons, and extension metadata.
2. Review every tool annotation for local extension requirements.
3. Make config prompts portable and user-friendly for Desktop install.
4. Package the extension with the official `mcpb` toolchain.
5. Test one-click install on clean Claude Desktop setups.
6. Submit the local extension for directory review when the bundle is polished enough.

## Recommended Product Positioning

Short version:

- local-first today
- bundle-ready next
- remote URL later only if the product architecture changes
