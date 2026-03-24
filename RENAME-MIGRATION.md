# Repo Rename And Migration Plan

Target rename:

- current GitHub repository: `anyrxo/protonmail-pro-mcp`
- target GitHub repository: `anyrxo/proton-mail-bridge-mcp`
- product name: `Proton Mail Bridge MCP`

This plan is intentionally conservative. The goal is to improve the name without breaking existing users, existing links, or current Claude Desktop installs.

## Goal

Move the repository and public project surface from `protonmail-pro-mcp` to `proton-mail-bridge-mcp` while keeping:

- current GitHub links working during the transition
- current local clones easy to update
- current MCP installs understandable
- any existing npm consumers migratable without surprise

## What Is Already Done

- product-facing docs now use `Proton Mail Bridge MCP`
- MCP server metadata now uses `proton-mail-bridge-mcp`
- Claude Desktop installer now defaults to `proton-mail-bridge`
- binary compatibility keeps both:
  - `protonmail-pro-mcp`
  - `proton-mail-bridge-mcp`

## Recommended Rollout

### Phase 1. Stabilize The New Product Name

Do this first and release it before renaming the GitHub repo.

- keep the current GitHub repository path for one transition release
- keep both CLI bin names
- keep the existing package name if it is already in use
- update README, installer defaults, and MCP metadata to the new product name
- add a migration note that the repository path rename is planned

Status:

- completed in-repo

### Phase 2. Rename The GitHub Repository

This requires GitHub admin permission on the repository.

Rename:

- from `protonmail-pro-mcp`
- to `proton-mail-bridge-mcp`

After the rename:

- GitHub should redirect normal repository web URLs and Git remotes from the old path to the new path
- do not recreate a new repository with the old name, because that can break the redirect
- if this repository is ever exposed as a GitHub Action, note that GitHub does not redirect Action uses after a rename

Immediately after the rename, update:

- `package.json` `homepage`
- `package.json` `repository.url`
- `package.json` `bugs.url`
- README clone examples
- README manual Claude Desktop paths
- badges and external directory links if needed

## Local Clone Migration

After the GitHub repo is renamed, existing users can update their clone with:

```bash
git remote set-url origin https://github.com/anyrxo/proton-mail-bridge-mcp.git
```

## npm Package Migration

If the package is already published and you want the npm package name to change too, do not unpublish the old package just to rename it.

Safer path:

1. publish the package under the new npm name
2. keep the old package available temporarily
3. deprecate the old package with a clear migration message

Suggested deprecation message:

```text
Package renamed to @sirency/proton-mail-bridge-mcp. Please migrate to the new package name.
```

Recommended transition window:

- at least one stable release with both names documented
- then deprecate the old package

## Claude Desktop Migration

Current installs may still use an MCP key like:

- `protonmail-pro`

New installs should use:

- `proton-mail-bridge`

Recommended approach:

- do not break the old key automatically
- update docs and installer defaults to the new key
- mention in release notes that users can keep the old key or rename it manually

Example manual rename inside `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "proton-mail-bridge": {
      "command": "node",
      "args": ["/absolute/path/to/proton-mail-bridge-mcp/dist/index.js"],
      "cwd": "/absolute/path/to/proton-mail-bridge-mcp"
    }
  }
}
```

## Release Checklist

Before the GitHub rename:

- ship the docs-first transition release
- confirm all README references are clear about the pending rename
- keep both bin names

During the GitHub rename:

- rename the repository in GitHub settings
- verify old repo URLs redirect
- verify `git fetch` from old remotes still works

After the GitHub rename:

- update `package.json` URLs
- update README clone examples
- update external listings like Glama if they need the new repository path
- publish release notes with a short migration section

## Suggested Release Note Copy

```text
This project is now branded as Proton Mail Bridge MCP. The GitHub repository path will move from anyrxo/protonmail-pro-mcp to anyrxo/proton-mail-bridge-mcp. Existing GitHub links and git remotes should continue to redirect, but updating your local remote is recommended.
```

## Official References

- GitHub repository rename behavior: https://docs.github.com/en/repositories/creating-and-managing-repositories/renaming-a-repository
- npm deprecate guidance: https://docs.npmjs.com/deprecating-and-undeprecating-packages-or-package-versions
- npm rename reality: publish under the new name instead of trying to “rename” in place: https://docs.npmjs.com/unpublishing-packages-from-the-registry
