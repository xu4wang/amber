# Amber

**Run it once. Keep it forever.**（跑通一次，随时再用。）

Amber turns an operation that someone got working together with an LLM agent into a reviewed,
deterministic command for Feishu (Lark). Commands run without a model in the loop.

## How it works

1. **Submit** — an agent submits a draft: parameters plus one or more Python steps. Nothing in the draft is trusted.
2. **Claim** — Amber posts a claim card to the chat the command belongs to. A person runs a trial with their
   own identity (taken from the Feishu event, not from the agent) and submits it for review.
3. **Review** — Amber writes the full code into a Feishu wiki doc and starts a Feishu approval;
   every configured reviewer must approve. The approved spec hash is pinned; any change needs a new review.
4. **Run** — in the chat (or the owner's private chat with Amber), `@Amber` lists the commands, collects parameters
   with a card form and updates the card in place with the result.

## Design rules

- **One concept: the command.** A command is parameters + steps; each step carries its own code.
  - `script` steps run in a macOS sandbox: no reads under `$HOME`, writes only to a per-run temp dir,
    network only when declared.
  - `privileged` steps run without the sandbox and can only be approved by an admin
    (their trial runs still use the sandbox).
- **Output is content.** Steps print Markdown; ` ```vega-lite ` and ` ```table ` blocks are adapted by each channel
  (Feishu cards get native charts / tables; a web UI can render the same content fully).
- **Scope.** A command belongs to the group or private chat it was created in; admins can make it global.
- **Execution identity tokens.** For services a step declares, Amber signs a short-lived Ed25519 JWS
  (`iss amber`, `aud`, `sub` = caller union_id, command, spec hash, run, expiry). Services verify it with
  the public keys at `/v1/keys`. A step that talks to services cannot reach the internet.

## Running

Requires Node.js ≥ 24 (runs TypeScript directly) and macOS (`sandbox-exec`).

```sh
npm install
node src/main.ts            # Feishu long connection + local API on 127.0.0.1:7341
node src/cli.ts submit draft.json
```

Configuration lives in `~/.config/amber/` (`lark-app.env` with the app id/secret, `config.json` with
admins, reviewers, approval and wiki settings). Nothing in this repository contains credentials.

## Status

Early development. Not yet: write-operation confirmation, schedules, web UI.
