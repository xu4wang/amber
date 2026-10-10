import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export type ScopeType = 'group' | 'p2p';
export type CommandStatus = 'draft' | 'pending' | 'active' | 'rejected' | 'retired';

export interface ParamDef {
  name: string;
  label?: string;
  type: 'string' | 'integer';
  required?: boolean;
  default?: string;
  /** Use a value Amber knows about the caller when the user leaves the field empty, e.g. their office city. Falls back to `default`. */
  defaultFrom?: 'caller.city';
  maxLength?: number;
  pattern?: string;
  min?: number;
  max?: number;
  /** "config" (#3): a configuration item, not asked at each run. The person in charge sets its value once on the
   *  website; every run gets it. Name and type are reviewed with the code, the value is not. */
  scope?: 'config';
}

export type { Script } from './runner.ts';
import type { Script } from './runner.ts';

export interface CommandOptions {
  /** Only runnable from the form card with a red confirm button; the one-line shortcut opens the form. */
  confirm: boolean;
  /** May be run by a schedule (no person clicks anything). */
  schedulable: boolean;
}

export function normalizeOptions(o: unknown): CommandOptions {
  const x = (o ?? {}) as Record<string, unknown>;
  return { confirm: x.confirm === true, schedulable: x.schedulable === true };
}

export interface CommandRow {
  id: string;
  scopeType: ScopeType;
  chatId: string;
  ownerUnionId: string;
  name: string;
  description: string;
  params: ParamDef[];
  script: Script;
  /** Set by the submitter, approved together with the code (D30). */
  options: CommandOptions;
  status: CommandStatus;
  specHash: string;
  createdAt: number;
  /** true = usable in every chat Amber is in (promoted by an admin); false = only where it was created. */
  global: boolean;
  /** The command's line in its chat (#4): its versions share it, and so do its secrets and configuration.
   *  A submitted command's line is its name; a Store installation gets its own, so several people can install
   *  the same app in one chat without sharing anything. */
  line: string;
}

export function computeSpecHash(c: Pick<CommandRow, 'name' | 'params' | 'script' | 'options'>): string {
  const canonical = JSON.stringify({ name: c.name, params: c.params, script: c.script, options: c.options });
  return createHash('sha256').update(canonical).digest('hex');
}

export type ExecutorStatus = 'pending' | 'approved' | 'rejected' | 'revoked';
/** An environment on an executor: the directory {WORKDIR} stands for, and the Python to use there. */
export interface ExecutorEnv {
  workdir: string; interpreter?: string;
  /** What scripts in this environment may access (D51). Absent = {WORKDIR} read-write. */
  access?: { readOnly?: string[]; readWrite?: string[]; deny?: string[] };
  /** Extra environment variables for scripts, e.g. LARKSUITE_CLI_CONFIG_DIR for a bot's lark-cli identity. */
  vars?: Record<string, string>;
  /** Where the definition came from, e.g. "botmux:cli_xxx". Shown to admins. */
  source?: string;
  /** HOME is the user's real home (as in the bot's own sessions) instead of the run dir. */
  realHome?: boolean;
  /** The definition file this environment follows (D53): once approved, changes to its paths, variables or
   *  Python take effect without a new approval (admins are notified and can revoke). */
  follow?: string;
}
export interface ExecutorRow {
  id: string; name: string; fingerprint: string; signPub: string; boxPub: string; envs: Record<string, ExecutorEnv>;
  machine: string; version: string; status: ExecutorStatus; createdAt: number; decidedBy: string | null; decidedAt: number | null; lastSeen: number | null;
}

export interface RunRow {
  id: string; commandId: string; channel: string; callerUnionId: string; chatId: string; args: Record<string, string>;
  status: string; result: string | null; error: string | null; startedAt: number; finishedAt: number | null;
}

export interface AppRow {
  id: string; name: string; description: string;
  /** The original's creator: may delist it; their new versions become the app's new versions (phase 2). */
  maintainerUnionId: string;
  /** The original command (chat + line) the app was listed from. */
  originChatId: string; originLine: string;
  status: 'listed' | 'delisted';
  createdAt: number; updatedAt: number;
}

export interface ListingRow {
  id: string; commandId: string; specHash: string; requestedBy: string;
  status: 'pending' | 'approved' | 'rejected' | 'canceled';
  approvalInstance: string | null; docUrl: string | null; docId: string | null;
  /** Card review (no Feishu approval configured): reviewers who approved so far. */
  approvedBy: string[];
  reason: string | null; createdAt: number;
}

export type RequestKind = 'run' | 'schedule' | 'schedule_resume' | 'schedule_delete' | 'retire' | 'scope_global' | 'scope_local' | 'reassign' | 'clone';
export type RequestStatus = 'awaiting' | 'running' | 'done' | 'failed' | 'canceled' | 'expired';
export interface RequestRow {
  id: string; kind: RequestKind; commandId: string | null; specHash: string | null; chatId: string; chatType: ScopeType;
  /** Only this person may click (union_id); null = anyone in the chat. */
  targetUnionId: string | null;
  args: Record<string, string>; rule: unknown | null; scheduleId: string | null;
  requestedBy: string; replyTo: string | null; inThread: boolean; messageId: string | null; status: RequestStatus;
  runId: string | null; actorUnionId: string | null; error: string | null; createdAt: number; finishedAt: number | null;
}

export type ScheduleStatus = 'active' | 'paused' | 'deleted';
export interface ScheduleRow {
  id: string; commandId: string; specHash: string; chatId: string; chatType: ScopeType; replyTo: string | null; inThread: boolean;
  creatorUnionId: string; creatorOpenId: string | null; args: Record<string, string>; rule: import('./schedule-rule.ts').Rule;
  status: ScheduleStatus; pauseReason: string | null; nextRunAt: number; lastRunId: string | null; lastRunAt: number | null;
  lastStatus: string | null; failCount: number; requestedBy: string | null; createdAt: number;
}

export class Store {
  db: DatabaseSync;

  constructor(dataDir: string) {
    this.db = new DatabaseSync(join(dataDir, 'amber.db'));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS commands (
        id TEXT PRIMARY KEY,
        scope_type TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        owner_union_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        params_json TEXT NOT NULL,
        script_json TEXT NOT NULL,
        side_effect TEXT NOT NULL,
        status TEXT NOT NULL,
        spec_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      DROP INDEX IF EXISTS commands_scope_name;
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        command_id TEXT NOT NULL,
        spec_hash TEXT NOT NULL,
        channel TEXT NOT NULL,
        caller_union_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        args_json TEXT NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        result TEXT,
        started_at INTEGER NOT NULL,
        finished_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit (
        at INTEGER NOT NULL,
        actor_union_id TEXT,
        action TEXT NOT NULL,
        detail TEXT NOT NULL
      );
    `);
    let cols = (this.db.prepare(`PRAGMA table_info(commands)`).all() as { name: string }[]).map(c => c.name);
    if (cols.includes('steps_json')) this.migrateStepsToScript();
    cols = (this.db.prepare(`PRAGMA table_info(commands)`).all() as { name: string }[]).map(c => c.name);
    if (!cols.includes('options_json')) this.migrateSideEffectToOptions();
    if (!cols.includes('global')) this.db.exec(`ALTER TABLE commands ADD COLUMN global INTEGER NOT NULL DEFAULT 0`);
    for (const [col, ddl] of [
      ['expected_claimer', 'TEXT'],      // union_id that must claim (p2p drafts), or NULL
      ['trial_by', 'TEXT'],              // union_id whose trial run succeeded on this revision
      ['claim_message_id', 'TEXT'],      // message id of the claim card
      ['origin_message_id', 'TEXT'],     // message the draft should reply to (thread placement)
      ['submitted_by', 'TEXT'],          // machine / submitter label
      ['owner_open_id', 'TEXT'],         // creator's open_id in the Amber app (for display only)
      ['approval_instance', 'TEXT'],     // Feishu approval instance code for the pending revision
      ['review_doc_url', 'TEXT'],        // wiki doc with the full code of the pending revision
      ['review_doc_id', 'TEXT'],
      ['replaces', 'TEXT'],
      ['line', 'TEXT'],                  // the command's line (#4); NULL = its name
      ['app_id', 'TEXT'],                // a Store installation: the app and version it was installed from (#4)
      ['app_version', 'INTEGER'],              // id of the active command this draft is a new version of (D38)
    ] as const) if (!cols.includes(col)) this.db.exec(`ALTER TABLE commands ADD COLUMN ${col} ${ddl}`);
    // One active command per line per chat (#4; a submitted command's line is its name). A new version
    // (draft/pending) may exist next to it (D38). Store installations have lines of their own.
    this.db.exec(`DROP INDEX IF EXISTS commands_active_name;
      CREATE UNIQUE INDEX IF NOT EXISTS commands_active_line ON commands(chat_id, COALESCE(line, name)) WHERE status = 'active';`);
    // Command secrets (D48): encrypted values, keyed by the command's lineage (chat + name) so a new version keeps them.
    this.db.exec(`CREATE TABLE IF NOT EXISTS command_secrets (
      chat_id TEXT NOT NULL,
      cmd_name TEXT NOT NULL,
      name TEXT NOT NULL,
      cipher TEXT NOT NULL,
      last4 TEXT NOT NULL DEFAULT '',
      set_by TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (chat_id, cmd_name, name)
    )`);
    // Amber Store (#4): listed apps, their versions (each one an approved command spec), and listing requests.
    this.db.exec(`CREATE TABLE IF NOT EXISTS apps (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      maintainer_union_id TEXT NOT NULL,
      origin_chat_id TEXT NOT NULL,
      origin_line TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS app_versions (
      app_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      command_id TEXT NOT NULL,
      spec_hash TEXT NOT NULL,
      doc_url TEXT,
      listed_at INTEGER NOT NULL,
      PRIMARY KEY (app_id, version)
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS app_listings (
      id TEXT PRIMARY KEY,
      command_id TEXT NOT NULL,
      spec_hash TEXT NOT NULL,
      requested_by TEXT NOT NULL,
      status TEXT NOT NULL,
      approval_instance TEXT,
      doc_url TEXT,
      doc_id TEXT,
      approved_by TEXT NOT NULL DEFAULT '[]',
      reason TEXT,
      created_at INTEGER NOT NULL,
      decided_at INTEGER
    )`);
    // Configuration items (#3): plain values, keyed like secrets by the command's lineage (chat + name).
    this.db.exec(`CREATE TABLE IF NOT EXISTS command_config (
      chat_id TEXT NOT NULL,
      cmd_name TEXT NOT NULL,
      name TEXT NOT NULL,
      value TEXT NOT NULL,
      set_by TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (chat_id, cmd_name, name)
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS reviews (
      command_id TEXT NOT NULL,
      spec_hash TEXT NOT NULL,
      reviewer_union_id TEXT NOT NULL,
      decision TEXT NOT NULL,
      reason TEXT,
      at INTEGER NOT NULL,
      PRIMARY KEY (command_id, spec_hash, reviewer_union_id)
    )`);
    // Agent-initiated actions that need a person's click in Feishu (D33): run as that person,
    // create / resume / delete a schedule. The click establishes the identity, never the agent.
    this.db.exec(`CREATE TABLE IF NOT EXISTS requests (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      command_id TEXT,
      spec_hash TEXT,
      chat_id TEXT NOT NULL,
      chat_type TEXT NOT NULL,
      target_union_id TEXT,
      args_json TEXT NOT NULL DEFAULT '{}',
      rule_json TEXT,
      schedule_id TEXT,
      requested_by TEXT NOT NULL,
      reply_to TEXT,
      in_thread INTEGER NOT NULL DEFAULT 0,
      message_id TEXT,
      status TEXT NOT NULL,
      run_id TEXT,
      actor_union_id TEXT,
      error TEXT,
      created_at INTEGER NOT NULL,
      finished_at INTEGER
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY,
      command_id TEXT NOT NULL,
      spec_hash TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      chat_type TEXT NOT NULL,
      reply_to TEXT,
      in_thread INTEGER NOT NULL DEFAULT 0,
      creator_union_id TEXT NOT NULL,
      creator_open_id TEXT,
      args_json TEXT NOT NULL,
      rule_json TEXT NOT NULL,
      status TEXT NOT NULL,
      pause_reason TEXT,
      next_run_at INTEGER NOT NULL,
      last_run_id TEXT,
      last_run_at INTEGER,
      last_status TEXT,
      fail_count INTEGER NOT NULL DEFAULT 0,
      requested_by TEXT,
      created_at INTEGER NOT NULL
    )`);
    // Website login through a chat with Amber (D34). Only hashes of tokens are stored.
    this.db.exec(`CREATE TABLE IF NOT EXISTS web_logins (
      token_hash TEXT PRIMARY KEY,
      union_id TEXT NOT NULL,
      open_id TEXT,
      message_id TEXT,
      created_at INTEGER NOT NULL,
      used_at INTEGER
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS web_sessions (
      session_hash TEXT PRIMARY KEY,
      union_id TEXT NOT NULL,
      open_id TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      revoked INTEGER NOT NULL DEFAULT 0
    )`);
    // Executors (D50): one row per key pair. Only an admin's approval lets Amber send it jobs.
    this.db.exec(`CREATE TABLE IF NOT EXISTS executors (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      sign_pub TEXT NOT NULL,
      box_pub TEXT NOT NULL,
      envs_json TEXT NOT NULL,
      machine TEXT NOT NULL,
      version TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      decided_by TEXT,
      decided_at INTEGER,
      last_seen INTEGER
    )`);
    const runCols = (this.db.prepare(`PRAGMA table_info(runs)`).all() as { name: string }[]).map(c => c.name);
    if (!runCols.includes('schedule_id')) this.db.exec('ALTER TABLE runs ADD COLUMN schedule_id TEXT');
  }

  /** D28: commands used to hold a list of steps. One-step commands become a single script (same code,
   *  new representation, so the spec hash is recomputed and audited); anything else is retired. */
  private migrateStepsToScript(): void {
    this.db.exec('ALTER TABLE commands RENAME COLUMN steps_json TO script_json');
    const rows = this.db.prepare('SELECT id, name, params_json, script_json, side_effect, status, spec_hash FROM commands').all() as Record<string, string>[];
    for (const r of rows) {
      const v = JSON.parse(r.script_json);
      if (!Array.isArray(v)) continue;
      const one = v.length === 1 && v[0] && typeof v[0].code === 'string' ? v[0] : null;
      if (!one) {
        this.db.prepare('UPDATE commands SET script_json = ?, status = ? WHERE id = ?').run(JSON.stringify({ kind: 'script', lang: 'python', code: '# 已停用：多步骤应用不再支持' }), r.status === 'retired' || r.status === 'rejected' ? r.status : 'retired', r.id);
        continue;
      }
      const script = { ...one };
      const hash = computeSpecHash({ name: r.name, params: JSON.parse(r.params_json), script, options: { confirm: r.side_effect === 'write', schedulable: false } });
      this.db.prepare('UPDATE commands SET script_json = ?, spec_hash = ? WHERE id = ?').run(JSON.stringify(script), hash, r.id);
      this.db.prepare('INSERT INTO audit (at, actor_union_id, action, detail) VALUES (?,?,?,?)').run(Date.now(), null, 'migrate.single_script', JSON.stringify({ id: r.id, oldSpec: r.spec_hash, newSpec: hash }));
    }
  }

  /** D30: the read/write declaration becomes two plain options. A former "write" command keeps the
   *  extra confirmation (confirm = true); nothing is schedulable until reviewed again. */
  private migrateSideEffectToOptions(): void {
    this.db.exec('ALTER TABLE commands ADD COLUMN options_json TEXT');
    const rows = this.db.prepare('SELECT id, name, params_json, script_json, side_effect, spec_hash FROM commands').all() as Record<string, string>[];
    for (const r of rows) {
      const options = { confirm: r.side_effect === 'write', schedulable: false };
      let hash = r.spec_hash;
      try {
        hash = computeSpecHash({ name: r.name, params: JSON.parse(r.params_json), script: JSON.parse(r.script_json), options });
      } catch { /* unreadable legacy row: keep as is */ }
      this.db.prepare('UPDATE commands SET options_json = ?, spec_hash = ? WHERE id = ?').run(JSON.stringify(options), hash, r.id);
      this.db.prepare('INSERT INTO audit (at, actor_union_id, action, detail) VALUES (?,?,?,?)').run(Date.now(), null, 'migrate.options', JSON.stringify({ id: r.id, oldSpec: r.spec_hash, newSpec: hash, options }));
    }
  }

  private toRow(r: Record<string, unknown>): CommandRow {
    return {
      id: String(r.id),
      scopeType: r.scope_type as ScopeType,
      chatId: String(r.chat_id),
      ownerUnionId: String(r.owner_union_id),
      name: String(r.name),
      description: String(r.description ?? ''),
      params: JSON.parse(String(r.params_json)),
      script: JSON.parse(String(r.script_json)),
      options: normalizeOptions(r.options_json ? JSON.parse(String(r.options_json)) : { confirm: r.side_effect === 'write' }),
      status: r.status as CommandStatus,
      specHash: String(r.spec_hash),
      createdAt: Number(r.created_at),
      global: Number(r.global ?? 0) === 1,
      line: r.line ? String(r.line) : String(r.name),
    };
  }

  insertCommand(c: Omit<CommandRow, 'id' | 'specHash' | 'createdAt' | 'global' | 'line'> & { line?: string }): CommandRow {
    c = { ...c, options: normalizeOptions(c.options) };
    const row: CommandRow = { ...c, id: randomUUID().slice(0, 8), specHash: computeSpecHash(c), createdAt: Date.now(), global: false, line: c.line ?? c.name };
    this.db.prepare(`INSERT INTO commands (id, scope_type, chat_id, owner_union_id, name, description, params_json, script_json, side_effect, status, spec_hash, created_at, line)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(row.id, row.scopeType, row.chatId, row.ownerUnionId, row.name, row.description,
      JSON.stringify(row.params), JSON.stringify(row.script), 'n/a', row.status, row.specHash, row.createdAt, row.line === row.name ? null : row.line);
    this.db.prepare('UPDATE commands SET options_json = ? WHERE id = ?').run(JSON.stringify(row.options), row.id);
    return row;
  }

  getCommand(id: string): CommandRow | undefined {
    const r = this.db.prepare('SELECT * FROM commands WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? this.toRow(r) : undefined;
  }

  listActiveByChat(chatId: string): CommandRow[] {
    return (this.db.prepare(`SELECT * FROM commands WHERE chat_id = ? AND status = 'active' ORDER BY name`).all(chatId) as Record<string, unknown>[]).map(r => this.toRow(r));
  }

  listActiveP2pByOwner(unionId: string): CommandRow[] {
    return (this.db.prepare(`SELECT * FROM commands WHERE scope_type = 'p2p' AND owner_union_id = ? AND status = 'active' ORDER BY name`).all(unionId) as Record<string, unknown>[]).map(r => this.toRow(r));
  }

  /** Live (not retired/rejected) commands whose stored script fails `check` — the same validation a
   *  new draft gets. Reported at startup; runCommand refuses them anyway. */
  listInvalidScripts(check: (script: unknown) => void): { id: string; name: string; status: string; reason: 'invalid_script'; error: string }[] {
    const rows = this.db.prepare(`SELECT id, name, status, script_json FROM commands WHERE status NOT IN ('retired', 'rejected')`).all() as Record<string, string>[];
    const out: { id: string; name: string; status: string; reason: 'invalid_script'; error: string }[] = [];
    for (const r of rows) {
      try { check(JSON.parse(r.script_json)); } catch (e) { out.push({ id: r.id, name: r.name, status: r.status, reason: 'invalid_script', error: (e as Error).message }); }
    }
    return out;
  }

  listActiveGlobal(): CommandRow[] {
    return (this.db.prepare(`SELECT * FROM commands WHERE global = 1 AND status = 'active' ORDER BY name`).all() as Record<string, unknown>[]).map(r => this.toRow(r));
  }

  setGlobal(id: string, global: boolean): void {
    this.db.prepare('UPDATE commands SET global = ? WHERE id = ?').run(global ? 1 : 0, id);
  }

  listAll(): CommandRow[] {
    return (this.db.prepare('SELECT * FROM commands ORDER BY created_at').all() as Record<string, unknown>[]).map(r => this.toRow(r));
  }

  getMeta(id: string): { expectedClaimer?: string; trialBy?: string; claimMessageId?: string; originMessageId?: string; ownerOpenId?: string; submittedBy?: string; replaces?: string } {
    const r = this.db.prepare('SELECT expected_claimer, trial_by, claim_message_id, origin_message_id, owner_open_id, submitted_by, replaces FROM commands WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return {
      replaces: (r?.replaces as string) || undefined,
      expectedClaimer: (r?.expected_claimer as string) || undefined,
      trialBy: (r?.trial_by as string) || undefined,
      claimMessageId: (r?.claim_message_id as string) || undefined,
      originMessageId: (r?.origin_message_id as string) || undefined,
      ownerOpenId: (r?.owner_open_id as string) || undefined,
      submittedBy: (r?.submitted_by as string) || undefined,
    };
  }

  setMeta(id: string, m: { expectedClaimer?: string | null; trialBy?: string | null; claimMessageId?: string | null; originMessageId?: string | null; submittedBy?: string | null; ownerUnionId?: string; ownerOpenId?: string | null; replaces?: string | null }): void {
    const map: Record<string, string> = { replaces: 'replaces', expectedClaimer: 'expected_claimer', trialBy: 'trial_by', claimMessageId: 'claim_message_id', originMessageId: 'origin_message_id', submittedBy: 'submitted_by', ownerUnionId: 'owner_union_id', ownerOpenId: 'owner_open_id' };
    for (const [k, v] of Object.entries(m)) {
      if (v === undefined) continue;
      this.db.prepare(`UPDATE commands SET ${map[k]} = ? WHERE id = ?`).run(v, id);
    }
  }

  setReview(id: string, r: { instance?: string | null; docUrl?: string | null; docId?: string | null }): void {
    if (r.instance !== undefined) this.db.prepare('UPDATE commands SET approval_instance = ? WHERE id = ?').run(r.instance, id);
    if (r.docUrl !== undefined) this.db.prepare('UPDATE commands SET review_doc_url = ? WHERE id = ?').run(r.docUrl, id);
    if (r.docId !== undefined) this.db.prepare('UPDATE commands SET review_doc_id = ? WHERE id = ?').run(r.docId, id);
  }

  getReview(id: string): { instance?: string; docUrl?: string; docId?: string } {
    const r = this.db.prepare('SELECT approval_instance, review_doc_url, review_doc_id FROM commands WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return { instance: (r?.approval_instance as string) || undefined, docUrl: (r?.review_doc_url as string) || undefined, docId: (r?.review_doc_id as string) || undefined };
  }

  pendingApprovalInstances(): string[] {
    return (this.db.prepare(`SELECT approval_instance FROM commands WHERE status = 'pending' AND approval_instance IS NOT NULL`).all() as { approval_instance: string }[]).map(r => r.approval_instance);
  }

  commandByApprovalInstance(instance: string): string | undefined {
    const r = this.db.prepare('SELECT id FROM commands WHERE approval_instance = ?').get(instance) as { id?: string } | undefined;
    return r?.id;
  }

  lastTrialResult(commandId: string): string | undefined {
    const r = this.db.prepare(`SELECT result FROM runs WHERE command_id = ? AND channel LIKE '%.trial' AND status = 'ok' ORDER BY started_at DESC LIMIT 1`).get(commandId) as { result?: string } | undefined;
    return r?.result ?? undefined;
  }

  recentDraftsFor(claimer: string, windowMs: number): number {
    const r = this.db.prepare(`SELECT COUNT(*) AS n FROM commands WHERE expected_claimer = ? AND created_at > ?`).get(claimer, Date.now() - windowMs) as { n: number };
    return Number(r.n);
  }

  /** A draft or a revision under review with this name (only one version may be in progress at a time). */
  nameInProgress(chatId: string, line: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM commands WHERE chat_id = ? AND COALESCE(line, name) = ? AND status IN ('pending','draft')`).get(chatId, line);
  }

  /** A draft or a revision under review with this name here, whatever its line. */
  nameDraftInProgress(chatId: string, name: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM commands WHERE chat_id = ? AND name = ? AND status IN ('pending','draft')`).get(chatId, name);
  }

  /** Active apps in a chat with this name, whatever their line (several people may each have one). */
  activeByChatName(chatId: string, name: string): CommandRow[] {
    return (this.db.prepare(`SELECT * FROM commands WHERE chat_id = ? AND name = ? AND status = 'active' ORDER BY created_at`).all(chatId, name) as Record<string, unknown>[]).map(r => this.toRow(r));
  }

  /** The active version of a line in a chat. For a submitted command the line is its name, so this is also
   *  "the active command with this name" — never a Store installation, which has a line of its own. */
  activeByName(chatId: string, line: string): CommandRow | undefined {
    const r = this.db.prepare(`SELECT * FROM commands WHERE chat_id = ? AND COALESCE(line, name) = ? AND status = 'active'`).get(chatId, line) as Record<string, unknown> | undefined;
    return r ? this.toRow(r) : undefined;
  }

  /** Earlier versions: commands this one (transitively) replaced, newest first. */
  versionsOf(id: string): CommandRow[] {
    const out: CommandRow[] = [];
    let cur = this.getMeta(id).replaces;
    while (cur && out.length < 50) {
      const c = this.getCommand(cur);
      if (!c) break;
      out.push(c);
      cur = this.getMeta(cur).replaces;
    }
    return out;
  }

  recordReview(commandId: string, specHash: string, reviewer: string, decision: 'approve' | 'reject', reason: string | null): void {
    this.db.prepare(`INSERT OR REPLACE INTO reviews (command_id, spec_hash, reviewer_union_id, decision, reason, at) VALUES (?,?,?,?,?,?)`)
      .run(commandId, specHash, reviewer, decision, reason, Date.now());
  }

  reviewsFor(commandId: string, specHash: string): { reviewer: string; decision: string; reason: string | null }[] {
    return (this.db.prepare('SELECT reviewer_union_id, decision, reason FROM reviews WHERE command_id = ? AND spec_hash = ?').all(commandId, specHash) as Record<string, unknown>[])
      .map(r => ({ reviewer: String(r.reviewer_union_id), decision: String(r.decision), reason: (r.reason as string) ?? null }));
  }

  setStatus(id: string, status: CommandStatus): void {
    this.db.prepare('UPDATE commands SET status = ? WHERE id = ?').run(status, id);
  }

  startRun(r: { commandId: string; specHash: string; channel: string; callerUnionId: string; chatId: string; args: Record<string, string> }): string {
    // Full random id: run and request ids are printed on cards, and must not be enumerable.
    const id = randomUUID();
    this.db.prepare(`INSERT INTO runs (id, command_id, spec_hash, channel, caller_union_id, chat_id, args_json, status, started_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(id, r.commandId, r.specHash, r.channel, r.callerUnionId, r.chatId, JSON.stringify(r.args), 'running', Date.now());
    return id;
  }

  /** Runs left 'running' by a previous process (it was stopped mid-run): mark them failed. */
  failInterruptedRuns(): string[] {
    const ids = (this.db.prepare(`SELECT id FROM runs WHERE status = 'running'`).all() as { id: string }[]).map(r => r.id);
    for (const id of ids) this.finishRun(id, 'failed', null, 'Amber 重启，执行被中断，请重新执行');
    return ids;
  }

  finishRun(id: string, status: 'ok' | 'failed', result: string | null, error: string | null): void {
    this.db.prepare('UPDATE runs SET status = ?, result = ?, error = ?, finished_at = ? WHERE id = ?').run(status, result, error, Date.now(), id);
  }

  getRun(id: string): RunRow | undefined {
    const r = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!r) return undefined;
    return {
      id: String(r.id), commandId: String(r.command_id), channel: String(r.channel), callerUnionId: String(r.caller_union_id), chatId: String(r.chat_id),
      args: JSON.parse(String(r.args_json)), status: String(r.status), result: (r.result as string) ?? null, error: (r.error as string) ?? null,
      startedAt: Number(r.started_at), finishedAt: r.finished_at ? Number(r.finished_at) : null,
    };
  }

  /** Recent runs started with this person's identity (any channel). */
  runsByCaller(unionId: string, limit: number): (RunRow & { commandName: string; scheduleId: string | null })[] {
    return (this.db.prepare(`SELECT r.*, c.name AS command_name FROM runs r LEFT JOIN commands c ON c.id = r.command_id WHERE r.caller_union_id = ? ORDER BY r.started_at DESC LIMIT ?`).all(unionId, limit) as Record<string, unknown>[])
      .map(r => ({ ...this.getRun(String(r.id))!, commandName: String(r.command_name ?? r.command_id), scheduleId: (r.schedule_id as string) ?? null }));
  }

  setRunSchedule(runId: string, scheduleId: string): void {
    this.db.prepare('UPDATE runs SET schedule_id = ? WHERE id = ?').run(scheduleId, runId);
  }

  // ---------- requests (D33)

  insertRequest(r: Omit<RequestRow, 'id' | 'status' | 'createdAt' | 'messageId' | 'runId' | 'actorUnionId' | 'error' | 'finishedAt'>): RequestRow {
    const row: RequestRow = { ...r, id: randomUUID(), status: 'awaiting', createdAt: Date.now(), messageId: null, runId: null, actorUnionId: null, error: null, finishedAt: null };
    this.db.prepare(`INSERT INTO requests (id, kind, command_id, spec_hash, chat_id, chat_type, target_union_id, args_json, rule_json, schedule_id, requested_by, reply_to, in_thread, status, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(row.id, row.kind, row.commandId, row.specHash, row.chatId, row.chatType, row.targetUnionId,
      JSON.stringify(row.args), row.rule ? JSON.stringify(row.rule) : null, row.scheduleId, row.requestedBy, row.replyTo, row.inThread ? 1 : 0, row.status, row.createdAt);
    return row;
  }

  /** Offers of a given kind still waiting for a click. */
  awaitingOffers(kind: RequestKind, commandId: string): RequestRow[] {
    return (this.db.prepare(`SELECT id FROM requests WHERE kind = ? AND command_id = ? AND status = 'awaiting'`).all(kind, commandId) as { id: string }[]).map(r => this.getRequest(r.id)!);
  }

  /** Reassignments of a command still waiting for the new owner's click. */
  awaitingReassigns(commandId: string): RequestRow[] {
    return (this.db.prepare(`SELECT id FROM requests WHERE kind = 'reassign' AND command_id = ? AND status = 'awaiting'`).all(commandId) as { id: string }[]).map(r => this.getRequest(r.id)!);
  }

  getRequest(id: string): RequestRow | undefined {
    const r = this.db.prepare('SELECT * FROM requests WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!r) return undefined;
    return {
      id: String(r.id), kind: r.kind as RequestKind, commandId: (r.command_id as string) ?? null, specHash: (r.spec_hash as string) ?? null,
      chatId: String(r.chat_id), chatType: r.chat_type as ScopeType, targetUnionId: (r.target_union_id as string) ?? null,
      args: JSON.parse(String(r.args_json)), rule: r.rule_json ? JSON.parse(String(r.rule_json)) : null, scheduleId: (r.schedule_id as string) ?? null,
      requestedBy: String(r.requested_by), replyTo: (r.reply_to as string) ?? null, inThread: Number(r.in_thread) === 1,
      messageId: (r.message_id as string) ?? null, status: r.status as RequestStatus, runId: (r.run_id as string) ?? null,
      actorUnionId: (r.actor_union_id as string) ?? null, error: (r.error as string) ?? null, createdAt: Number(r.created_at), finishedAt: r.finished_at ? Number(r.finished_at) : null,
    };
  }

  /** Moves a request from one status to another; false when someone else got there first (double click). */
  transitionRequest(id: string, from: RequestStatus, to: RequestStatus, f: { actorUnionId?: string; runId?: string; error?: string; scheduleId?: string; messageId?: string } = {}): boolean {
    const done = to !== 'awaiting' && to !== 'running';
    const r = this.db.prepare(`UPDATE requests SET status = ?, actor_union_id = COALESCE(?, actor_union_id), run_id = COALESCE(?, run_id), error = COALESCE(?, error),
      schedule_id = COALESCE(?, schedule_id), message_id = COALESCE(?, message_id), finished_at = ? WHERE id = ? AND status = ?`)
      .run(to, f.actorUnionId ?? null, f.runId ?? null, f.error ?? null, f.scheduleId ?? null, f.messageId ?? null, done ? Date.now() : null, id, from);
    return Number(r.changes) === 1;
  }

  setRequestMessage(id: string, messageId: string): void {
    this.db.prepare('UPDATE requests SET message_id = ? WHERE id = ?').run(messageId, id);
  }

  recentRequestsInChat(chatId: string, windowMs: number): number {
    const r = this.db.prepare('SELECT COUNT(*) AS n FROM requests WHERE chat_id = ? AND created_at > ?').get(chatId, Date.now() - windowMs) as { n: number };
    return Number(r.n);
  }

  // ---------- schedules (D32)

  insertSchedule(s: Omit<ScheduleRow, 'id' | 'createdAt' | 'status' | 'pauseReason' | 'lastRunId' | 'lastRunAt' | 'lastStatus' | 'failCount'>): ScheduleRow {
    const row: ScheduleRow = { ...s, id: randomUUID().slice(0, 8), createdAt: Date.now(), status: 'active', pauseReason: null, lastRunId: null, lastRunAt: null, lastStatus: null, failCount: 0 };
    this.db.prepare(`INSERT INTO schedules (id, command_id, spec_hash, chat_id, chat_type, reply_to, in_thread, creator_union_id, creator_open_id, args_json, rule_json, status, next_run_at, requested_by, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(row.id, row.commandId, row.specHash, row.chatId, row.chatType, row.replyTo, row.inThread ? 1 : 0,
      row.creatorUnionId, row.creatorOpenId, JSON.stringify(row.args), JSON.stringify(row.rule), row.status, row.nextRunAt, row.requestedBy, row.createdAt);
    return row;
  }

  private toSchedule(r: Record<string, unknown>): ScheduleRow {
    return {
      id: String(r.id), commandId: String(r.command_id), specHash: String(r.spec_hash), chatId: String(r.chat_id), chatType: r.chat_type as ScopeType,
      replyTo: (r.reply_to as string) ?? null, inThread: Number(r.in_thread) === 1, creatorUnionId: String(r.creator_union_id), creatorOpenId: (r.creator_open_id as string) ?? null,
      args: JSON.parse(String(r.args_json)), rule: JSON.parse(String(r.rule_json)), status: r.status as ScheduleStatus, pauseReason: (r.pause_reason as string) ?? null,
      nextRunAt: Number(r.next_run_at), lastRunId: (r.last_run_id as string) ?? null, lastRunAt: r.last_run_at ? Number(r.last_run_at) : null,
      lastStatus: (r.last_status as string) ?? null, failCount: Number(r.fail_count), requestedBy: (r.requested_by as string) ?? null, createdAt: Number(r.created_at),
    };
  }

  getSchedule(id: string): ScheduleRow | undefined {
    const r = this.db.prepare(`SELECT * FROM schedules WHERE id = ? AND status != 'deleted'`).get(id) as Record<string, unknown> | undefined;
    return r ? this.toSchedule(r) : undefined;
  }

  schedulesInChat(chatId: string): ScheduleRow[] {
    return (this.db.prepare(`SELECT * FROM schedules WHERE chat_id = ? AND status != 'deleted' ORDER BY created_at`).all(chatId) as Record<string, unknown>[]).map(r => this.toSchedule(r));
  }

  schedulesByCreator(unionId: string): ScheduleRow[] {
    return (this.db.prepare(`SELECT * FROM schedules WHERE creator_union_id = ? AND status != 'deleted' ORDER BY created_at`).all(unionId) as Record<string, unknown>[]).map(r => this.toSchedule(r));
  }

  schedulesOfCommand(commandId: string): ScheduleRow[] {
    return (this.db.prepare(`SELECT * FROM schedules WHERE command_id = ? AND status != 'deleted' ORDER BY created_at`).all(commandId) as Record<string, unknown>[]).map(r => this.toSchedule(r));
  }

  rebindSchedule(id: string, commandId: string, specHash: string): void {
    this.db.prepare('UPDATE schedules SET command_id = ?, spec_hash = ? WHERE id = ?').run(commandId, specHash, id);
  }

  allSchedules(): ScheduleRow[] {
    return (this.db.prepare(`SELECT * FROM schedules WHERE status != 'deleted' ORDER BY created_at`).all() as Record<string, unknown>[]).map(r => this.toSchedule(r));
  }

  dueSchedules(now: number): ScheduleRow[] {
    return (this.db.prepare(`SELECT * FROM schedules WHERE status = 'active' AND next_run_at <= ? ORDER BY next_run_at`).all(now) as Record<string, unknown>[]).map(r => this.toSchedule(r));
  }

  updateSchedule(id: string, f: Partial<Pick<ScheduleRow, 'status' | 'pauseReason' | 'nextRunAt' | 'lastRunId' | 'lastRunAt' | 'lastStatus' | 'failCount'>>): void {
    const map: Record<string, string> = { status: 'status', pauseReason: 'pause_reason', nextRunAt: 'next_run_at', lastRunId: 'last_run_id', lastRunAt: 'last_run_at', lastStatus: 'last_status', failCount: 'fail_count' };
    for (const [k, v] of Object.entries(f)) {
      if (v === undefined) continue;
      this.db.prepare(`UPDATE schedules SET ${map[k]} = ? WHERE id = ?`).run(v as string | number | null, id);
    }
  }

  // ---------- website login (D34)

  insertWebLogin(tokenHash: string, unionId: string, openId: string | null): void {
    this.db.prepare('INSERT INTO web_logins (token_hash, union_id, open_id, created_at) VALUES (?,?,?,?)').run(tokenHash, unionId, openId, Date.now());
  }

  setWebLoginMessage(tokenHash: string, messageId: string): void {
    this.db.prepare('UPDATE web_logins SET message_id = ? WHERE token_hash = ?').run(messageId, tokenHash);
  }

  /** Marks a login link used; returns it only if it was unused and younger than maxAgeMs. */
  consumeWebLogin(tokenHash: string, maxAgeMs: number): { unionId: string; openId: string | null; messageId: string | null } | undefined {
    const r = this.db.prepare('UPDATE web_logins SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND created_at > ?').run(Date.now(), tokenHash, Date.now() - maxAgeMs);
    if (Number(r.changes) !== 1) return undefined;
    const x = this.db.prepare('SELECT union_id, open_id, message_id FROM web_logins WHERE token_hash = ?').get(tokenHash) as Record<string, string | null>;
    return { unionId: String(x.union_id), openId: x.open_id, messageId: x.message_id };
  }

  recentWebLogins(unionId: string, windowMs: number): number {
    const r = this.db.prepare('SELECT COUNT(*) AS n FROM web_logins WHERE union_id = ? AND created_at > ?').get(unionId, Date.now() - windowMs) as { n: number };
    return Number(r.n);
  }

  insertWebSession(sessionHash: string, unionId: string, openId: string | null, ttlMs: number): void {
    this.db.prepare('INSERT INTO web_sessions (session_hash, union_id, open_id, created_at, expires_at) VALUES (?,?,?,?,?)').run(sessionHash, unionId, openId, Date.now(), Date.now() + ttlMs);
  }

  webSession(sessionHash: string): { unionId: string; openId: string | null } | undefined {
    const x = this.db.prepare('SELECT union_id, open_id FROM web_sessions WHERE session_hash = ? AND revoked = 0 AND expires_at > ?').get(sessionHash, Date.now()) as Record<string, string | null> | undefined;
    return x ? { unionId: String(x.union_id), openId: x.open_id } : undefined;
  }

  revokeWebSession(sessionHash: string): void {
    this.db.prepare('UPDATE web_sessions SET revoked = 1 WHERE session_hash = ?').run(sessionHash);
  }

  revokeWebSessionsOf(unionId: string): number {
    return Number(this.db.prepare('UPDATE web_sessions SET revoked = 1 WHERE union_id = ? AND revoked = 0').run(unionId).changes);
  }

  /** Group chats that have active commands or schedules (candidates for "chats this person is in"). */
  groupChatsWithContent(): string[] {
    return (this.db.prepare(`SELECT DISTINCT chat_id FROM commands WHERE status = 'active' AND scope_type = 'group'
      UNION SELECT DISTINCT chat_id FROM schedules WHERE status != 'deleted' AND chat_type = 'group'`).all() as { chat_id: string }[]).map(r => r.chat_id);
  }

  putSecret(chatId: string, cmdName: string, name: string, cipher: string, last4: string, by: string): void {
    this.db.prepare(`INSERT INTO command_secrets (chat_id, cmd_name, name, cipher, last4, set_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (chat_id, cmd_name, name) DO UPDATE SET cipher = excluded.cipher, last4 = excluded.last4, set_by = excluded.set_by, updated_at = excluded.updated_at`)
      .run(chatId, cmdName, name, cipher, last4, by, Date.now());
  }

  secretRows(chatId: string, cmdName: string): { name: string; cipher: string; last4: string; setBy: string; updatedAt: number }[] {
    return (this.db.prepare(`SELECT name, cipher, last4, set_by, updated_at FROM command_secrets WHERE chat_id = ? AND cmd_name = ? ORDER BY name`).all(chatId, cmdName) as Record<string, unknown>[])
      .map(r => ({ name: String(r.name), cipher: String(r.cipher), last4: String(r.last4), setBy: String(r.set_by), updatedAt: Number(r.updated_at) }));
  }

  deleteSecret(chatId: string, cmdName: string, name: string): boolean {
    return Number(this.db.prepare(`DELETE FROM command_secrets WHERE chat_id = ? AND cmd_name = ? AND name = ?`).run(chatId, cmdName, name).changes) > 0;
  }

  deleteSecretsOf(chatId: string, cmdName: string): number {
    return Number(this.db.prepare(`DELETE FROM command_secrets WHERE chat_id = ? AND cmd_name = ?`).run(chatId, cmdName).changes);
  }

  // ---- Amber Store (#4)

  insertApp(a: Omit<AppRow, 'createdAt' | 'updatedAt'>): AppRow {
    const now = Date.now();
    this.db.prepare(`INSERT INTO apps (id, name, description, maintainer_union_id, origin_chat_id, origin_line, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(a.id, a.name, a.description, a.maintainerUnionId, a.originChatId, a.originLine, a.status, now, now);
    return this.getApp(a.id)!;
  }

  private appRow(r: Record<string, unknown> | undefined): AppRow | undefined {
    return r ? { id: String(r.id), name: String(r.name), description: String(r.description), maintainerUnionId: String(r.maintainer_union_id), originChatId: String(r.origin_chat_id),
      originLine: String(r.origin_line), status: r.status as AppRow['status'], createdAt: Number(r.created_at), updatedAt: Number(r.updated_at) } : undefined;
  }

  getApp(id: string): AppRow | undefined { return this.appRow(this.db.prepare('SELECT * FROM apps WHERE id = ?').get(id) as Record<string, unknown> | undefined); }

  appByOrigin(chatId: string, line: string): AppRow | undefined {
    return this.appRow(this.db.prepare('SELECT * FROM apps WHERE origin_chat_id = ? AND origin_line = ?').get(chatId, line) as Record<string, unknown> | undefined);
  }

  listApps(status?: AppRow['status']): AppRow[] {
    return (this.db.prepare(`SELECT * FROM apps ${status ? 'WHERE status = ?' : ''} ORDER BY name`).all(...(status ? [status] : [])) as Record<string, unknown>[]).map(r => this.appRow(r)!);
  }

  setAppOrigin(id: string, chatId: string, line: string, maintainer: string): void {
    this.db.prepare('UPDATE apps SET origin_chat_id = ?, origin_line = ?, maintainer_union_id = ?, updated_at = ? WHERE id = ?').run(chatId, line, maintainer, Date.now(), id);
  }

  setAppMaintainer(id: string, maintainer: string): void { this.db.prepare('UPDATE apps SET maintainer_union_id = ?, updated_at = ? WHERE id = ?').run(maintainer, Date.now(), id); }

  setAppStatus(id: string, status: AppRow['status']): void { this.db.prepare('UPDATE apps SET status = ?, updated_at = ? WHERE id = ?').run(status, Date.now(), id); }

  addAppVersion(appId: string, commandId: string, specHash: string, docUrl: string | null): number {
    const v = Number((this.db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM app_versions WHERE app_id = ?').get(appId) as { v: number }).v) + 1;
    this.db.prepare('INSERT INTO app_versions (app_id, version, command_id, spec_hash, doc_url, listed_at) VALUES (?,?,?,?,?,?)').run(appId, v, commandId, specHash, docUrl, Date.now());
    this.db.prepare('UPDATE apps SET updated_at = ? WHERE id = ?').run(Date.now(), appId);
    return v;
  }

  appVersions(appId: string): { version: number; commandId: string; specHash: string; docUrl: string | null; listedAt: number }[] {
    return (this.db.prepare('SELECT * FROM app_versions WHERE app_id = ? ORDER BY version DESC').all(appId) as Record<string, unknown>[])
      .map(r => ({ version: Number(r.version), commandId: String(r.command_id), specHash: String(r.spec_hash), docUrl: (r.doc_url as string) ?? null, listedAt: Number(r.listed_at) }));
  }

  setInstall(commandId: string, appId: string, version: number): void { this.db.prepare('UPDATE commands SET app_id = ?, app_version = ? WHERE id = ?').run(appId, version, commandId); }

  installOf(commandId: string): { appId: string; version: number } | undefined {
    const r = this.db.prepare('SELECT app_id, app_version FROM commands WHERE id = ?').get(commandId) as Record<string, unknown> | undefined;
    return r?.app_id ? { appId: String(r.app_id), version: Number(r.app_version) } : undefined;
  }

  installsOf(appId: string): CommandRow[] {
    return (this.db.prepare(`SELECT * FROM commands WHERE app_id = ? AND status = 'active'`).all(appId) as Record<string, unknown>[]).map(r => this.toRow(r));
  }

  insertListing(l: { commandId: string; specHash: string; requestedBy: string }): ListingRow {
    const id = randomUUID();
    this.db.prepare(`INSERT INTO app_listings (id, command_id, spec_hash, requested_by, status, created_at) VALUES (?,?,?,?, 'pending', ?)`).run(id, l.commandId, l.specHash, l.requestedBy, Date.now());
    return this.getListing(id)!;
  }

  private listingRow(r: Record<string, unknown> | undefined): ListingRow | undefined {
    return r ? { id: String(r.id), commandId: String(r.command_id), specHash: String(r.spec_hash), requestedBy: String(r.requested_by), status: r.status as ListingRow['status'],
      approvalInstance: (r.approval_instance as string) ?? null, docUrl: (r.doc_url as string) ?? null, docId: (r.doc_id as string) ?? null,
      approvedBy: JSON.parse(String(r.approved_by ?? '[]')), reason: (r.reason as string) ?? null, createdAt: Number(r.created_at) } : undefined;
  }

  getListing(id: string): ListingRow | undefined { return this.listingRow(this.db.prepare('SELECT * FROM app_listings WHERE id = ?').get(id) as Record<string, unknown> | undefined); }

  listingByInstance(instance: string): ListingRow | undefined {
    return this.listingRow(this.db.prepare('SELECT * FROM app_listings WHERE approval_instance = ?').get(instance) as Record<string, unknown> | undefined);
  }

  pendingListingFor(commandId: string): ListingRow | undefined {
    return this.listingRow(this.db.prepare(`SELECT * FROM app_listings WHERE command_id = ? AND status = 'pending'`).get(commandId) as Record<string, unknown> | undefined);
  }

  pendingListingInstances(): string[] {
    return (this.db.prepare(`SELECT approval_instance FROM app_listings WHERE status = 'pending' AND approval_instance IS NOT NULL`).all() as { approval_instance: string }[]).map(r => r.approval_instance);
  }

  updateListing(id: string, f: { approvalInstance?: string; docUrl?: string; docId?: string; approvedBy?: string[]; status?: ListingRow['status']; reason?: string | null }, onlyIfPending = true): boolean {
    const cur = this.getListing(id);
    if (!cur || (onlyIfPending && cur.status !== 'pending')) return false;
    const n = { ...cur, ...f };
    this.db.prepare(`UPDATE app_listings SET approval_instance = ?, doc_url = ?, doc_id = ?, approved_by = ?, status = ?, reason = ?, decided_at = ? WHERE id = ? AND status = ?`)
      .run(n.approvalInstance, n.docUrl, n.docId, JSON.stringify(n.approvedBy), n.status, n.reason, n.status === 'pending' ? null : Date.now(), id, cur.status);
    return true;
  }

  putConfig(chatId: string, cmdName: string, name: string, value: string, by: string): void {
    this.db.prepare(`INSERT INTO command_config (chat_id, cmd_name, name, value, set_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (chat_id, cmd_name, name) DO UPDATE SET value = excluded.value, set_by = excluded.set_by, updated_at = excluded.updated_at`)
      .run(chatId, cmdName, name, value, by, Date.now());
  }

  configRows(chatId: string, cmdName: string): { name: string; value: string; setBy: string; updatedAt: number }[] {
    return (this.db.prepare(`SELECT name, value, set_by, updated_at FROM command_config WHERE chat_id = ? AND cmd_name = ? ORDER BY name`).all(chatId, cmdName) as Record<string, unknown>[])
      .map(r => ({ name: String(r.name), value: String(r.value), setBy: String(r.set_by), updatedAt: Number(r.updated_at) }));
  }

  deleteConfig(chatId: string, cmdName: string, name: string): boolean {
    return Number(this.db.prepare(`DELETE FROM command_config WHERE chat_id = ? AND cmd_name = ? AND name = ?`).run(chatId, cmdName, name).changes) > 0;
  }

  deleteConfigOf(chatId: string, cmdName: string): number {
    return Number(this.db.prepare(`DELETE FROM command_config WHERE chat_id = ? AND cmd_name = ?`).run(chatId, cmdName).changes);
  }

  private executorRow(r: Record<string, unknown> | undefined): ExecutorRow | undefined {
    if (!r) return undefined;
    return { id: String(r.id), name: String(r.name), fingerprint: String(r.fingerprint), signPub: String(r.sign_pub), boxPub: String(r.box_pub),
      envs: JSON.parse(String(r.envs_json)), machine: String(r.machine), version: String(r.version), status: r.status as ExecutorStatus,
      createdAt: Number(r.created_at), decidedBy: r.decided_by ? String(r.decided_by) : null, decidedAt: r.decided_at ? Number(r.decided_at) : null, lastSeen: r.last_seen ? Number(r.last_seen) : null };
  }

  getExecutor(id: string): ExecutorRow | undefined { return this.executorRow(this.db.prepare('SELECT * FROM executors WHERE id = ?').get(id) as Record<string, unknown> | undefined); }

  /** The approved executor with this name, if any (at most one). */
  approvedExecutor(name: string): ExecutorRow | undefined { return this.executorRow(this.db.prepare(`SELECT * FROM executors WHERE name = ? AND status = 'approved'`).get(name) as Record<string, unknown> | undefined); }

  listExecutors(): ExecutorRow[] { return (this.db.prepare(`SELECT * FROM executors ORDER BY name, created_at`).all() as Record<string, unknown>[]).map(r => this.executorRow(r)!); }

  /** New registration, or a known key pair asking again (environments changed): back to pending. */
  putExecutor(e: Pick<ExecutorRow, 'id' | 'name' | 'fingerprint' | 'signPub' | 'boxPub' | 'envs' | 'machine' | 'version'>): void {
    this.db.prepare(`INSERT INTO executors (id, name, fingerprint, sign_pub, box_pub, envs_json, machine, version, status, created_at) VALUES (?,?,?,?,?,?,?,?, 'pending', ?)
      ON CONFLICT (id) DO UPDATE SET name = excluded.name, envs_json = excluded.envs_json, machine = excluded.machine, version = excluded.version, status = 'pending', decided_by = NULL, decided_at = NULL`)
      .run(e.id, e.name, e.fingerprint, e.signPub, e.boxPub, JSON.stringify(e.envs), e.machine, e.version, Date.now());
  }

  setExecutorStatus(id: string, status: ExecutorStatus, by: string | null): void {
    this.db.prepare('UPDATE executors SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?').run(status, by, Date.now(), id);
  }

  /** An approved executor's environments changed within what it is allowed to follow (D53): status unchanged. */
  updateExecutorEnvs(id: string, envs: Record<string, ExecutorEnv>, machine: string, version: string): void {
    this.db.prepare('UPDATE executors SET envs_json = ?, machine = ?, version = ? WHERE id = ?').run(JSON.stringify(envs), machine, version, id);
  }

  touchExecutor(id: string): void { this.db.prepare('UPDATE executors SET last_seen = ? WHERE id = ?').run(Date.now(), id); }

  /** Site-wide settings an admin changes on the website (e.g. the card footer). Missing = default. */
  getSetting(k: string): string | undefined {
    const r = this.db.prepare('SELECT v FROM settings WHERE k = ?').get(k) as { v: string } | undefined;
    return r?.v;
  }

  setSetting(k: string, v: string | null): void {
    if (v === null) this.db.prepare('DELETE FROM settings WHERE k = ?').run(k);
    else this.db.prepare('INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v').run(k, v);
  }

  audit(actorUnionId: string | null, action: string, detail: Record<string, unknown>): void {
    this.db.prepare('INSERT INTO audit (at, actor_union_id, action, detail) VALUES (?,?,?,?)').run(Date.now(), actorUnionId, action, JSON.stringify(detail));
  }
}
