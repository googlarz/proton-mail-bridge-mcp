import test from "node:test";
import assert from "node:assert/strict";
import {
  buildWizardEnv,
  normalizePortInput,
  parseYesNoAnswer,
} from "../dist/scripts/setup-claude-desktop.js";

test("parseYesNoAnswer supports blank values and common yes or no inputs", () => {
  assert.equal(parseYesNoAnswer("", true), true);
  assert.equal(parseYesNoAnswer("y", false), true);
  assert.equal(parseYesNoAnswer("No", true), false);
});

test("normalizePortInput keeps the fallback for blank values", () => {
  assert.equal(normalizePortInput("", 1143), 1143);
  assert.equal(normalizePortInput("1025", 1143), 1025);
});

test("buildWizardEnv fills the standard Proton Bridge defaults", () => {
  const env = buildWizardEnv({
    username: "user@proton.me",
    password: "bridge-pass",
  });

  assert.equal(env.PROTONMAIL_USERNAME, "user@proton.me");
  assert.equal(env.PROTONMAIL_PASSWORD, "bridge-pass");
  assert.equal(env.PROTONMAIL_IMAP_HOST, "127.0.0.1");
  assert.equal(env.PROTONMAIL_IMAP_PORT, "1143");
  assert.equal(env.PROTONMAIL_SMTP_HOST, "127.0.0.1");
  assert.equal(env.PROTONMAIL_SMTP_PORT, "1025");
  assert.equal(env.PROTONMAIL_AUTO_SYNC, "true");
  assert.equal(env.PROTONMAIL_ALLOW_SEND, "true");
  assert.match(env.PROTONMAIL_ALLOWED_ACTIONS, /archive/);
});
