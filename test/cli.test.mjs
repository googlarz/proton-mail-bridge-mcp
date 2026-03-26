import test from "node:test";
import assert from "node:assert/strict";
import { parseCliArgs } from "../dist/cli.js";

test("parseCliArgs handles basic commands and flags", () => {
  const parsed = parseCliArgs(["search", "invoice", "--folder", "INBOX", "--json"]);

  assert.equal(parsed.command, "search");
  assert.deepEqual(parsed.positionals, ["invoice"]);
  assert.equal(parsed.flags.folder, "INBOX");
  assert.equal(parsed.flags.json, true);
});

test("parseCliArgs handles claude subcommands", () => {
  const parsed = parseCliArgs(["claude", "check", "--json"]);

  assert.equal(parsed.command, "claude");
  assert.equal(parsed.subcommand, "check");
  assert.deepEqual(parsed.positionals, []);
  assert.equal(parsed.flags.json, true);
});

test("parseCliArgs handles generic tool calls", () => {
  const parsed = parseCliArgs([
    "tool",
    "search_indexed_emails",
    "--args",
    '{"query":"invoice","limit":2}',
  ]);

  assert.equal(parsed.command, "tool");
  assert.deepEqual(parsed.positionals, ["search_indexed_emails"]);
  assert.equal(parsed.flags.args, '{"query":"invoice","limit":2}');
});

test("parseCliArgs handles tools listing", () => {
  const parsed = parseCliArgs(["tools", "--json"]);

  assert.equal(parsed.command, "tools");
  assert.deepEqual(parsed.positionals, []);
  assert.equal(parsed.flags.json, true);
});
