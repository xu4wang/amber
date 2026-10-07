// Smoke test against a running deployment (npm run smoke). Run it on the Amber machine.
// Checks what the offline tests cannot: the real service is up, the agent API and website answer,
// and Feishu accepts every kind of card Amber sends (Feishu rejects malformed cards on send).
//
// Optional ~/.config/amber/smoke.json:
//   { "testChat": "oc_…" }   a test group with Amber in it: cards are sent there and recalled right away
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as lark from '@larksuiteoapi/node-sdk';
import { loadConfig } from '../src/config.ts';
import * as cards from '../src/cards.ts';
import { claimCard } from '../src/flow.ts';
import type { CommandRow } from '../src/db.ts';

const cfg = loadConfig();
const smoke = (() => { const p = join(cfg.configDir, 'smoke.json'); return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {}; })();
const api = `http://127.0.0.1:${process.env.AMBER_API_PORT ?? 7341}`;
const web = cfg.webBaseUrl;
let failed = 0;
const check = async (name: string, f: () => Promise<string | void>) => {
  try { const note = await f(); console.log(`✔ ${name}${note ? `：${note}` : ''}`); }
  catch (e) { failed++; console.log(`✖ ${name}：${(e as Error).message}`); }
};
const must = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };
const getJson = async (url: string, init?: RequestInit) => { const r = await fetch(url, init); return { status: r.status, body: await r.json().catch(() => null) }; };

await check('agent 接口：/v1/info', async () => {
  const r = await getJson(`${api}/v1/info`);
  must(r.body?.ok && r.body.webUrl === web, JSON.stringify(r.body));
  return `网站 ${r.body.webUrl}`;
});
await check('公钥：/v1/keys', async () => {
  const r = await getJson(`${api}/v1/keys`);
  must(r.body?.keys?.[0]?.crv === 'Ed25519', 'no Ed25519 key');
  return `kid ${r.body.keys[0].kid}`;
});
await check('网站首页与文档', async () => {
  for (const p of ['/', '/docs', '/docs/usage', '/docs/identity-example', '/logo.svg']) {
    const r = await fetch(web + p);
    must(r.status === 200, `${p} → ${r.status}`);
  }
});
await check('网站前端库完整', async () => {
  for (const f of ['marked.min.js', 'purify.min.js', 'vega.min.js', 'vega-lite.min.js', 'vega-embed.min.js', 'highlight.min.js']) {
    const want = readFileSync(join(import.meta.dirname, '..', 'web', 'vendor', f));
    const got = Buffer.from(await (await fetch(`${web}/vendor/${f}`)).arrayBuffer());
    must(want.equals(got), `${f} 不完整（${got.length}/${want.length} 字节）`);
  }
});
await check('网站未登录时拒绝访问', async () => {
  must((await fetch(`${web}/web/api/me`)).status === 401, 'expected 401');
});
await check('登录链接无效时拒绝', async () => {
  must((await fetch(`${web}/login?t=invalid`, { redirect: 'manual' })).status === 400, 'expected 400');
});

if (smoke.testChat) {
  const client = new lark.Client({ appId: cfg.appId, appSecret: cfg.appSecret, loggerLevel: lark.LoggerLevel.error });
  // Recall what we sent; a failure here would leave test cards in the group, so it fails the check.
  const recall = async (id: string) => {
    const d = await client.im.v1.message.delete({ path: { message_id: id } }) as any;
    must((d?.code ?? 0) === 0, `撤回失败：${d?.msg ?? ''}`);
  };
  const sample: CommandRow = {
    id: 'smoke000', scopeType: 'group', chatId: smoke.testChat, ownerUnionId: '', name: '冒烟测试', description: '冒烟测试用的示例指令',
    params: [{ name: 'days', label: '天数', type: 'integer', default: '7' }], script: { kind: 'script', lang: 'python', code: 'print("hello")\n' },
    options: { confirm: true, schedulable: true }, status: 'active', specHash: 'f'.repeat(64), createdAt: Date.now(), global: false,
  };
  const output = [{ kind: 'markdown' as const, text: '**结果**\n\n```table\n{"columns":[{"name":"d","label":"日期","type":"text"},{"name":"n","label":"数量","type":"number"}],"rows":[{"d":"10-01","n":3},{"d":"10-02","n":5}],"total":2}\n```\n```vega-lite\n{"mark":"line","data":{"values":[{"d":"10-01","n":3},{"d":"10-02","n":5}]},"encoding":{"x":{"field":"d","type":"ordinal"},"y":{"field":"n","type":"quantitative"}}}\n```' }];
  const all: [string, object][] = [
    ['指令列表', cards.listCard([sample], '本群')],
    ['执行表单', cards.formCard(sample, { days: '3' })],
    ['执行中', cards.runningCard(sample.name)],
    ['结果（表格 + 图表）', cards.resultCard(sample.name, undefined, output, 'run00000', 1234, sample.id)],
    ['错误', cards.errorCard(sample.name, '示例错误', sample.id)],
    ['认领卡', claimCard(sample, { blocks: output }, 'SmokeBot')],
    ['认领卡（新版本）', claimCard(sample, undefined, 'SmokeBot', { ...sample, script: { ...sample.script, code: 'print("old")\n' } })],
    ['确认卡（执行）', cards.requestCard({ kind: 'run', reqId: 'req00000', cmd: sample, args: { days: '3' }, requestedBy: 'SmokeBot' })],
    ['确认卡（定时）', cards.requestCard({ kind: 'schedule', reqId: 'req00001', cmd: sample, args: {}, requestedBy: 'SmokeBot', ruleText: '每天 09:00（北京时间）', nextText: '10月9日 周五 09:00' })],
    ['定时任务列表', cards.scheduleListCard([{ id: 'sch00000', name: sample.name, ruleText: '每天 09:00', nextText: '明天 09:00', status: 'active', pauseReason: null, creatorOpenId: null, lastText: '还没运行过', canManage: true }], '本群')],
    ['定时结果', cards.scheduleResultCard(sample.name, undefined, output, 'run00001', 900, 'sch00000', '每天 09:00')],
    ['换绑卡', cards.rebindCard({ scheduleId: 'sch00000', name: sample.name, ruleText: '每天 09:00', oldHash: 'a'.repeat(64), newId: 'smoke001', newHash: 'b'.repeat(64), stillSchedulable: true })],
    ['信息卡', cards.infoCard('冒烟测试', '这是一条冒烟测试消息，会立即撤回。')],
  ];
  for (const [name, card] of all) {
    await check(`飞书接受卡片：${name}`, async () => {
      const r = await client.im.v1.message.create({ params: { receive_id_type: 'chat_id' }, data: { receive_id: smoke.testChat, msg_type: 'interactive', content: JSON.stringify(card) } }) as any;
      const id = r?.data?.message_id;
      must(id, JSON.stringify(r?.msg ?? r));
      await recall(id);
    });
  }
  await check('读取测试群成员（群指令权限、退群暂停依赖它）', async () => {
    const r = await client.request({ method: 'GET', url: `/open-apis/im/v1/chats/${smoke.testChat}/members`, params: { member_id_type: 'union_id', page_size: 50 } }) as any;
    const n = r?.data?.items?.length ?? 0;
    must(n > 0, '读不到成员');
    return `${n} 位成员`;
  });
  await check('在话题里回复（结果回到原话题）', async () => {
    const root = await client.im.v1.message.create({ params: { receive_id_type: 'chat_id' }, data: { receive_id: smoke.testChat, msg_type: 'interactive', content: JSON.stringify(cards.infoCard('冒烟测试', '话题根消息，会立即撤回。')) } }) as any;
    const rootId = root?.data?.message_id;
    must(rootId, '根消息发送失败');
    const reply = await client.im.v1.message.reply({ path: { message_id: rootId }, data: { msg_type: 'interactive', content: JSON.stringify(cards.infoCard('冒烟测试', '话题内回复，会立即撤回。')), reply_in_thread: true } }) as any;
    const replyId = reply?.data?.message_id;
    const threadId = reply?.data?.thread_id;
    for (const id of [replyId, rootId]) if (id) await recall(id);
    must(replyId && threadId, '没有进入话题');
  });
} else {
  console.log('- 跳过卡片检查：没有配置 testChat（~/.config/amber/smoke.json）');
}

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
