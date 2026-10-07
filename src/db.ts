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

export interface CommandRow {
  id: string;
  scopeType: ScopeType;
  chatId: string;
  ownerUnionId: string;
  name: string;
  description: string;
  params: ParamDef[];
  script: Script;
  sideEffect: 'read' | 'write';
  status: CommandStatus;
  specHash: string;
  createdAt: number;
  /** true = usable in every chat Amber is in (promoted by an admin); false = only where it was created. */
  global: boolean;
}

export function computeSpecHash(c: Pick<CommandRow, 'name' | 'params' | 'script' | 'sideEffect'>): string {
  const canonical = JSON.stringify({ name: c.name, params: c.params, script: c.script, sideEffect: c.sideEffect });
  return createHash('sha256').update(canonical).digest('hex');
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
      const hash = computeSpecHash({ name: r.name, params: JSON.parse(r.params_json), script, sideEffect: r.side_effect as 'read' | 'write' });
      this.db.prepare('UPDATE commands SET script_json = ?, spec_hash = ? WHERE id = ?').run(JSON.stringify(script), hash, r.id);
      this.db.prepare('INSERT INTO audit (at, actor_union_id, action, detail) VALUES (?,?,?,?)').run(Date.now(), null, 'migrate.single_script', JSON.stringify({ id: r.id, oldSpec: r.spec_hash, newSpec: hash }));
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
      sideEffect: r.side_effect as 'read' | 'write',
      status: r.status as CommandStatus,
      specHash: String(r.spec_hash),
      createdAt: Number(r.created_at),
      global: Number(r.global ?? 0) === 1,
    };
  }

  insertCommand(c: Omit<CommandRow, 'id' | 'specHash' | 'createdAt' | 'global'>): CommandRow {
    const row: CommandRow = { ...c, id: randomUUID().slice(0, 8), specHash: computeSpecHash(c), createdAt: Date.now(), global: false };
    this.db.prepare(`INSERT INTO commands (id, scope_type, chat_id, owner_union_id, name, description, params_json, script_json, side_effect, status, spec_hash, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(row.id, row.scopeType, row.chatId, row.ownerUnionId, row.name, row.description,
      JSON.stringify(row.params), JSON.stringify(row.script), row.sideEffect, row.status, row.specHash, row.createdAt);
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

  audit(actorUnionId: string | null, action: string, detail: Record<string, unknown>): void {
    this.db.prepare('INSERT INTO audit (at, actor_union_id, action, detail) VALUES (?,?,?,?)').run(Date.now(), actorUnionId, action, JSON.stringify(detail));
  }
}
