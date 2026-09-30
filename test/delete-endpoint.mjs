/**
 * 删除端点的形状回归（独立于 dsh 运行，仓外临时目录里真删文件）。
 *
 * 复现 2026-09-29 22:4x 的真实事故：0.2.0 的 `sessionPersistence.stat()/list()`
 * 返回的是**快照** `{header, revision, sizeBytes}`，而端点按 0.1.x 的形状当 header
 * 用（`candidate.id`），于是每一次删除都判成「会话不存在」→ UI 报「删除失败：unknown」。
 * 三档输入都必须走到同一个 header：快照 + 有 stat（现行）、快照 + 只有 list、
 * 裸 header + 只有 list（旧形状）。
 *
 *   node test/delete-endpoint.mjs
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SESSION_ID = 'sess-shape-1';

// ---- 一次调用的宿主端夹具：返回 { result, calls } ------------------------------
async function runOnce({ persistence, withLiveSession = false, entryBusy = false, archivedHere = true }) {
	const scratch = mkdtempSync(join(tmpdir(), 'shredder-delete-'));
	const sessionDir = join(scratch, 'project', SESSION_ID);
	mkdirSync(join(sessionDir, 'artifacts'), { recursive: true });
	writeFileSync(join(sessionDir, 'session.jsonl'), '{"seq":1}\n');

	const calls = { unarchive: [], parallel: [], flush: 0, detach: 0 };
	let route = null;
	const header = { id: SESSION_ID, cwd: 'C:/fixture/project', createdAt: 1 };

	const liveSession = { id: SESSION_ID, header };
	const storeEntry = { session: liveSession, announcing: entryBusy, appending: false, detachRequested: false };
	const sessions = {
		get: (id) => (withLiveSession && id === SESSION_ID ? liveSession : undefined),
		list: () => (withLiveSession ? [liveSession] : []),
		flush: async () => { calls.flush++; },
		store: { get: (id) => (id === SESSION_ID && withLiveSession ? storeEntry : undefined) },
		detachEntered: () => { calls.detach++; },
	};
	const registry = {
		unarchiveSession: async (id) => { calls.unarchive.push(id); },
		archivedSessionIds: archivedHere ? [SESSION_ID] : [],
		list: () => [],
	};

	const ctx = {
		webServer: { register: (routeDef) => { route = routeDef; return () => { route = null; }; } },
		get: (name) => ({ workspaceRegistry: registry, sessions, sessionPersistence: persistence(sessionDir) })[name],
		effect: (fn) => fn(),
		parallel: async (event, payload) => { calls.parallel.push([event, payload]); },
	};

	const { apply } = await import('../lib/index.js');
	await apply(ctx);
	assert.ok(route, 'host half registers a route');
	assert.equal(route.path, '/dsh-shredder/delete');

	const body = Buffer.from(JSON.stringify({ sessionId: SESSION_ID }));
	const req = { method: 'POST', async *[Symbol.asyncIterator]() { yield body; } };
	let payload;
	const res = { writeHead: () => {}, end: (text) => { payload = text; } };
	await route.handler(req, res);

	const result = JSON.parse(payload);
	const survived = existsSync(sessionDir);
	rmSync(scratch, { recursive: true, force: true });
	return { result, survived, calls };
}

// 三档 persistence 夹具：差别只在 stat/list 给什么形状
const snapshottedWithStat = (sessionDir) => ({
	stat: async (id) => (id === SESSION_ID ? { header: { id, cwd: 'C:/fixture/project' }, revision: 'r1', sizeBytes: 12 } : undefined),
	locate: () => ({ kind: 'jsonl', path: join(sessionDir, 'session.jsonl') }),
});
const snapshottedListOnly = (sessionDir) => ({
	list: async () => [{ header: { id: SESSION_ID, cwd: 'C:/fixture/project' }, revision: 'r1', sizeBytes: 12 }],
	locate: () => ({ kind: 'jsonl', path: join(sessionDir, 'session.jsonl') }),
});
const legacyHeaderList = (sessionDir) => ({
	list: async () => [{ id: SESSION_ID, cwd: 'C:/fixture/project' }],
	locate: () => ({ kind: 'jsonl', path: join(sessionDir, 'session.jsonl') }),
});
const emptyStore = (sessionDir) => ({
	stat: async () => undefined,
	locate: () => ({ kind: 'jsonl', path: join(sessionDir, 'session.jsonl') }),
});

const cases = [
	['0.2.0 快照 + stat（现行路径）', snapshottedWithStat, true],
	['0.2.0 快照 + 只有 list', snapshottedListOnly, true],
	['旧形状：list 直接给 header', legacyHeaderList, true],
];

for (const [name, factory, withLiveSession] of cases) {
	const { result, survived, calls } = await runOnce({ persistence: factory, withLiveSession });
	assert.equal(result.ok, true, `${name} → ok:true（实际 ${JSON.stringify(result)}）`);
	assert.equal(survived, false, `${name} → 会话目录被物理删除`);
	assert.deepEqual(calls.unarchive, [SESSION_ID], `${name} → 走官方 unarchiveSession`);
	assert.equal(calls.parallel[0]?.[0], 'workspace/session-stop', `${name} → 先问官方停止缝`);
	console.log(`ok — ${name}: setUpdate=${result.setUpdate} membershipUpdate=${result.membershipUpdate} evicted=${result.evicted}`);
}

// 活会话那一发必须真的把驻留实例拆掉（entry.detach 走通）
const live = await runOnce({ persistence: snapshottedWithStat, withLiveSession: true });
assert.equal(live.result.evicted, 'ok', 'live session evicted through entry.detach');

// 22:5x 真机那一格：驱逐来不及（会话正忙 ⇒ deferred）或本进程没有它（absent）时，
// 请求里绝不许清归档标记——否则那一行还挂在各标签页上，会话会从"归档"跳进普通列表，
// 点进去就是 session/not-found。两种情况都要"文件已删 + recordHeld"。
for (const [name, options, expected] of [
	['deferred（实例正忙，延后分离）', { withLiveSession: true, entryBusy: true }, 'held-deferred'],
	['absent（本进程没有这个实例）', { withLiveSession: false }, 'held-absent'],
]) {
	const held = await runOnce({ persistence: snapshottedWithStat, ...options });
	assert.equal(held.result.ok, true, `${name} → 文件删除本身算成功`);
	assert.equal(held.survived, false, `${name} → 目录确实被删`);
	assert.equal(held.result.recordHeld, true, `${name} → 标记暂留`);
	assert.equal(held.result.setUpdate, expected, `${name} → setUpdate=${expected}`);
	assert.deepEqual(held.calls.unarchive, [], `${name} → 请求里不许动归档集`);
	console.log(`ok — ${name}: evicted=${held.result.evicted} setUpdate=${held.result.setUpdate} recordHeld=${held.result.recordHeld}`);
}

// 幽灵归档记录（22:5x 真机那一格）：日志不在场、id 还挂在归档集 ⇒ 摘记录，且**不碰盘上目录**
const ghost = await runOnce({ persistence: emptyStore, withLiveSession: false, archivedHere: true });
assert.equal(ghost.result.ok, true, `幽灵记录 → ok:true（实际 ${JSON.stringify(ghost.result)}）`);
assert.equal(ghost.result.action, 'record-only', '幽灵记录只摘归档记录');
assert.equal(ghost.result.logPresent, false);
assert.deepEqual(ghost.calls.unarchive, [SESSION_ID], '幽灵记录走 unarchiveSession');
assert.equal(ghost.survived, true, '幽灵记录不许删任何目录');
console.log('ok — 幽灵归档记录：action=record-only setUpdate=' + ghost.result.setUpdate + '，目录未被触碰');

// 负对照：日志不在场、也不在归档集里 → 仍是 unknown（不许把"跟我无关"洗成成功）
const stranger = await runOnce({ persistence: emptyStore, withLiveSession: false, archivedHere: false });
assert.equal(stranger.result.ok, false);
assert.equal(stranger.result.reason, 'unknown', '与归档集无关的 id 仍判 unknown');
assert.deepEqual(stranger.calls.unarchive, [], 'unknown 那一格不许写归档集');
assert.equal(stranger.survived, true, 'unknown 那一格不许碰目录');
console.log('ok — 负对照：不在归档集就判 unknown，且不写记录、不删目录');

console.log('delete-endpoint smoke: all scenarios green');
