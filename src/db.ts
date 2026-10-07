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
}

export function computeSpecHash(c: Pick<CommandRow, 'name' | 'params' | 'script' | 'options'>): string {
  const canonical = JSON.stringify({ name: c.name, params: c.params, script: c.script, options: c.options });
  return createHash('sha256').update(canonical).digest('hex');
}

export interface RunRow {
  id: string; commandId: string; channel: string; callerUnionId: string; chatId: string; args: Record<string, string>;
  status: string; result: string | null; error: string | null; startedAt: number; finishedAt: number | null;
}

export type RequestKind = 'run' | 'schedule' | 'schedule_resume' | 'schedule_delete';
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
      CREATE UNIQUE INDEX IF NOT EXISTS commands_scope_name ON commands(chat_id, name) WHERE status IN ('active','pending','draft');
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
    ] as const) if (!cols.includes(col)) this.db.exec(`ALTER TABLE commands ADD COLUMN ${col} ${ddl}`);
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
        this.db.prepare('UPDATE commands SET script_json = ?, status = ? WHERE id = ?').run(JSON.stringify({ kind: 'script', lang: 'python', code: '# 已停用：多步骤指令不再支持' }), r.status === 'retired' || r.status === 'rejected' ? r.status : 'retired', r.id);
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
    };
  }

  insertCommand(c: Omit<CommandRow, 'id' | 'specHash' | 'createdAt' | 'global'>): CommandRow {
    c = { ...c, options: normalizeOptions(c.options) };
    const row: CommandRow = { ...c, id: randomUUID().slice(0, 8), specHash: computeSpecHash(c), createdAt: Date.now(), global: false };
    this.db.prepare(`INSERT INTO commands (id, scope_type, chat_id, owner_union_id, name, description, params_json, script_json, side_effect, status, spec_hash, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(row.id, row.scopeType, row.chatId, row.ownerUnionId, row.name, row.description,
      JSON.stringify(row.params), JSON.stringify(row.script), 'n/a', row.status, row.specHash, row.createdAt);
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

  listActiveGlobal(): CommandRow[] {
    return (this.db.prepare(`SELECT * FROM commands WHERE global = 1 AND status = 'active' ORDER BY name`).all() as Record<string, unknown>[]).map(r => this.toRow(r));
  }

  setGlobal(id: string, global: boolean): void {
    this.db.prepare('UPDATE commands SET global = ? WHERE id = ?').run(global ? 1 : 0, id);
  }

  listAll(): CommandRow[] {
    return (this.db.prepare('SELECT * FROM commands ORDER BY created_at').all() as Record<string, unknown>[]).map(r => this.toRow(r));
  }

  getMeta(id: string): { expectedClaimer?: string; trialBy?: string; claimMessageId?: string; originMessageId?: string; ownerOpenId?: string; submittedBy?: string } {
    const r = this.db.prepare('SELECT expected_claimer, trial_by, claim_message_id, origin_message_id, owner_open_id, submitted_by FROM commands WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return {
      expectedClaimer: (r?.expected_claimer as string) || undefined,
      trialBy: (r?.trial_by as string) || undefined,
      claimMessageId: (r?.claim_message_id as string) || undefined,
      originMessageId: (r?.origin_message_id as string) || undefined,
      ownerOpenId: (r?.owner_open_id as string) || undefined,
      submittedBy: (r?.submitted_by as string) || undefined,
    };
  }

  setMeta(id: string, m: { expectedClaimer?: string | null; trialBy?: string | null; claimMessageId?: string | null; originMessageId?: string | null; submittedBy?: string | null; ownerUnionId?: string; ownerOpenId?: string | null }): void {
    const map: Record<string, string> = { expectedClaimer: 'expected_claimer', trialBy: 'trial_by', claimMessageId: 'claim_message_id', originMessageId: 'origin_message_id', submittedBy: 'submitted_by', ownerUnionId: 'owner_union_id', ownerOpenId: 'owner_open_id' };
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

  nameTaken(chatId: string, name: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM commands WHERE chat_id = ? AND name = ? AND status IN ('active','pending','draft')`).get(chatId, name);
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
    const id = randomUUID().slice(0, 8);
    this.db.prepare(`INSERT INTO runs (id, command_id, spec_hash, channel, caller_union_id, chat_id, args_json, status, started_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(id, r.commandId, r.specHash, r.channel, r.callerUnionId, r.chatId, JSON.stringify(r.args), 'running', Date.now());
    return id;
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
    const row: RequestRow = { ...r, id: randomUUID().slice(0, 8), status: 'awaiting', createdAt: Date.now(), messageId: null, runId: null, actorUnionId: null, error: null, finishedAt: null };
    this.db.prepare(`INSERT INTO requests (id, kind, command_id, spec_hash, chat_id, chat_type, target_union_id, args_json, rule_json, schedule_id, requested_by, reply_to, in_thread, status, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(row.id, row.kind, row.commandId, row.specHash, row.chatId, row.chatType, row.targetUnionId,
      JSON.stringify(row.args), row.rule ? JSON.stringify(row.rule) : null, row.scheduleId, row.requestedBy, row.replyTo, row.inThread ? 1 : 0, row.status, row.createdAt);
    return row;
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

  audit(actorUnionId: string | null, action: string, detail: Record<string, unknown>): void {
    this.db.prepare('INSERT INTO audit (at, actor_union_id, action, detail) VALUES (?,?,?,?)').run(Date.now(), actorUnionId, action, JSON.stringify(detail));
  }
}
