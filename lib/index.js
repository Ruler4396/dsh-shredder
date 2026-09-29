// dsh-shredder — host half
// 已归档会话的"彻底删除"端点。浏览器半只往原生会话菜单里加一枚红行，
// 物理删目录这一步只能由宿主完成，所以整枚插件只有这一枚端点。
//   POST /dsh-shredder/delete   {sessionId}
//     停手 → 落盘 → 驱逐驻留实例 → 摘工作区成员槽 → 删目录 → 移出归档集
//
// 取消归档走官方 workspaceRegistry.unarchiveSession；探测不到该方法的运行时
// 才退回复刻 registry 自身的写入路径（enqueueOperation + setState）。

import { rm, lstat } from 'node:fs/promises'

export const name = 'shredder'

export const inject = ['webServer']

const messageOf = (error) => String((error && error.message) || error)

function sendJson(res, status, value) {
	res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
	res.end(JSON.stringify(value))
}

async function readJson(req) {
	const chunks = []
	for await (const chunk of req) chunks.push(chunk)
	if (chunks.length === 0) return {}
	try {
		const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
		return parsed && typeof parsed === 'object' ? parsed : {}
	} catch {
		return {}
	}
}

export async function apply(ctx) {
	const webServer = ctx.webServer

	// 该 id 现在是否在归档集里（幽灵记录判据：日志已不在，但 id 还挂着）。
	function isArchived(sessionId) {
		const registry = ctx.get('workspaceRegistry')
		if (registry === undefined) return 'unavailable'
		try {
			return Array.from(registry.archivedSessionIds, (id) => String(id)).includes(sessionId) ? 'yes' : 'no'
		} catch {
			return 'unavailable'
		}
	}

	// 移出归档集。0.2.0 起官方有 unarchiveSession；旧运行时按 registry 自己的
	// 写入路径复刻（必须 enqueueOperation 串行化，直改 storage 会与内存态失步）。
	async function removeFromArchiveSet(sessionId) {
		const registry = ctx.get('workspaceRegistry')
		if (registry === undefined) return { ok: false, how: 'unavailable' }
		const id = String(sessionId || '')
		if (!id) return { ok: false, how: 'bad-request' }
		if (typeof registry.unarchiveSession === 'function') {
			try {
				await registry.unarchiveSession(id)
			} catch (error) {
				return { ok: false, how: 'error', message: messageOf(error) }
			}
			return { ok: true, how: 'official' }
		}
		if (typeof registry.enqueueOperation !== 'function' || typeof registry.requireState !== 'function' || typeof registry.setState !== 'function') {
			return { ok: false, how: 'unsupported-host' }
		}
		try {
			await registry.enqueueOperation(async () => {
				const state = registry.requireState()
				if (!state.archivedSessionIds.includes(id)) return
				await registry.setState({
					...state,
					archivedSessionIds: state.archivedSessionIds.filter((member) => member !== id),
				})
			})
		} catch (error) {
			return { ok: false, how: 'error', message: messageOf(error) }
		}
		return { ok: true, how: 'replicated' }
	}

	// 官方停止缝：workspace/session-stop 由 agent(turn)/jobs/subagent/schedule 各自
	// 应答。归档只挡住新步（归档准入闸读归档集），在跑的这一步要请所有者收手。
	async function stopSessionWork(sessionId) {
		if (typeof ctx.parallel !== 'function') return 'unsupported'
		try {
			await ctx.parallel('workspace/session-stop', { sessionId })
			return 'ok'
		} catch (error) {
			return `failed: ${messageOf(error)}`
		}
	}

	// 把会话从其工作区成员表移除（官方写路径 WorkspaceEntity.detachSession：域写链
	// table.update，幂等、竞态安全）。必须在删除文件**之前**调用——mutate 的成员
	// 剪枝依赖 header 索引解析 canonical 路径。归档只隐藏会话且保留成员槽位，
	// 若不移除槽位，移出归档集的瞬间会话就会"闪回"工作区清单。
	async function detachFromOwnerWorkspace(sessionId) {
		const registry = ctx.get('workspaceRegistry')
		if (registry === undefined || typeof registry.list !== 'function') return 'unavailable'
		try {
			for (const entity of registry.list()) {
				let memberIds = []
				try { memberIds = Array.from(entity.sessionIds, (id) => String(id)) } catch { memberIds = [] }
				if (!memberIds.includes(sessionId)) continue
				if (typeof entity.detachSession === 'function') {
					await entity.detachSession(sessionId)
					return 'ok'
				}
				return 'unsupported'
			}
		} catch (error) {
			console.warn('[shredder] detach failed:', sessionId, messageOf(error))
			return 'failed'
		}
		return 'absent'
	}

	// 把驻留的活会话实例从 SessionStore 驱逐（运行时可见内部：store Map + entry.detach/
	// detachEntered，均有陈旧性守卫）。效果：广播 session/disposed → 各标签页立即删行；
	// 同时拆除 append publication hooks——此后该实例的任何事件都不再进入持久化管道，
	// 杜绝目录重建。忙碌（announcing/appending）时不硬拆，置 detachRequested 延迟到
	// 当前分派结束。
	function evictLiveSession(sessionId) {
		const store = ctx.get('sessions')
		if (store === undefined || typeof store.get !== 'function') return 'unavailable'
		const live = store.get(sessionId)
		if (live === undefined) return 'absent'
		try {
			const entry = store.store && typeof store.store.get === 'function' ? store.store.get(sessionId) : undefined
			if (entry === undefined || entry.session !== live) return 'unsupported'
			if (entry.announcing === true || entry.appending === true) {
				entry.detachRequested = true
				return 'deferred'
			}
			if (typeof entry.detach === 'function') {
				entry.detach()
				return 'ok'
			}
			if (typeof store.detachEntered === 'function') {
				store.detachEntered(entry)
				return 'ok'
			}
			return 'unsupported'
		} catch (error) {
			console.warn('[shredder] evict failed:', sessionId, messageOf(error))
			return 'failed'
		}
	}

	// header -> 会话目录绝对路径；布局不识别时返回 null。
	function sessionDirOf(header) {
		const persistence = ctx.get('sessionPersistence')
		if (persistence === undefined || typeof persistence.locate !== 'function') return null
		const located = persistence.locate(header)
		if (!located || located.kind !== 'jsonl' || typeof located.path !== 'string') return null
		const cutAt = Math.max(located.path.lastIndexOf('/'), located.path.lastIndexOf('\\'))
		if (cutAt <= 0) return null
		return located.path.slice(0, cutAt)
	}

	// 取一个会话的存储 header。dsh 0.2.0 的 stat()/list() 回的是**快照**
	// `{header, revision, sizeBytes}`（见 @deepseek-ai/dsh-session-persistence-jsonl
	// README：「快照携带所选文件的 sizeBytes 与尽力而为的修订号」），不是 header ——
	// 按 header 用就永远判成"会话不存在"。首选 stat(id)：list() 对历史格式要付一次
	// 全根指纹。
	async function storedHeaderOf(persistence, sessionId) {
		if (typeof persistence.stat === 'function') {
			const snapshot = await persistence.stat(sessionId)
			return snapshot === undefined ? undefined : snapshot.header
		}
		const idOf = (candidate) => {
			const header = (candidate && candidate.header) || candidate
			return String((header && header.id) || '')
		}
		const found = (await persistence.list()).find((candidate) => idOf(candidate) === sessionId)
		return found === undefined ? undefined : ((found.header) || found)
	}

	// 复活兜底（纯后台）：驻留实例的迟来 flush 可能在删除后重建目录。+2s/+6s/+15s
	// 三次静默复查，复活就再删；仍存活则记警告——成员表与归档集均已清除，UI 各处
	// 不会再显示它，最坏是孤儿目录。
	function scheduleResurrectionReapers(persistence, sessionId) {
		const delays = [2000, 6000, 15000]
		for (const delay of delays) {
			const timer = setTimeout(() => {
				void (async () => {
					try {
						const stillHeader = await storedHeaderOf(persistence, sessionId)
						if (stillHeader === undefined) return
						const dir = sessionDirOf(stillHeader)
						if (dir === null) return
						await rm(dir, { recursive: true, force: true })
						const present = await lstat(dir).then(() => true, () => false)
						if (present) console.warn('[shredder] resurrected dir survives reaper:', sessionId)
					} catch { /* best effort */ }
				})()
			}, delay)
			timer.unref?.()
		}
	}

	const deleteHandler = async (body) => {
		const sessionId = String((body && body.sessionId) || '')
		if (!sessionId) return { ok: false, reason: 'bad-request' }
		// 顺序即正确性：请所有者停手 → flush 排空缓冲 → 驱逐驻留实例（广播
		// session/disposed，各标签页立即删行；拆除 append hooks 杜绝重建）→ detach
		// 成员槽位 → rm 目录 → 移出归档集。驱逐后该会话在任何界面都无数据可渲染。
		const stopped = await stopSessionWork(sessionId)
		const liveSessions = ctx.get('sessions')
		if (liveSessions !== undefined && typeof liveSessions.get === 'function') {
			const live = liveSessions.get(sessionId)
			if (live !== undefined && typeof liveSessions.flush === 'function') {
				try { await liveSessions.flush(live) } catch { /* 删除照常进行 */ }
			}
		}
		const evicted = evictLiveSession(sessionId)
		const persistence = ctx.get('sessionPersistence')
		if (persistence === undefined || (typeof persistence.stat !== 'function' && typeof persistence.list !== 'function')) {
			return { ok: false, reason: 'unsupported-host', stopped, evicted }
		}
		let header
		try {
			header = await storedHeaderOf(persistence, sessionId)
		} catch (error) {
			return { ok: false, reason: 'error', message: messageOf(error), stopped, evicted }
		}
		if (header === undefined) {
			// 盘上没有日志、也不在本进程的 pending 里 ⇒ 这是一条**幽灵归档记录**（日志被
			// 别处删过，id 还挂在归档集里）。此时唯一完整的动作就是摘掉记录本身。
			if (isArchived(sessionId) !== 'yes') return { ok: false, reason: 'unknown', stopped, evicted }
			const ghostMembership = await detachFromOwnerWorkspace(sessionId)
			const ghostSet = await removeFromArchiveSet(sessionId)
			return {
				ok: ghostSet.ok, action: 'record-only', logPresent: false,
				membershipUpdate: ghostMembership, setUpdate: ghostSet.how, message: ghostSet.message,
				stopped, evicted,
			}
		}
		const membership = await detachFromOwnerWorkspace(sessionId)
		const sessionDir = sessionDirOf(header)
		if (sessionDir === null) return { ok: false, reason: 'unsupported-backend', membershipUpdate: membership, stopped, evicted }
		try {
			await rm(sessionDir, { recursive: true, force: true })
		} catch (error) {
			return { ok: false, reason: 'delete-failed', message: messageOf(error), membershipUpdate: membership, stopped, evicted }
		}
		const setRemoved = await removeFromArchiveSet(sessionId)
		scheduleResurrectionReapers(persistence, sessionId)
		return {
			ok: setRemoved.ok, action: 'deleted', logPresent: true,
			membershipUpdate: membership, setUpdate: setRemoved.how, message: setRemoved.message,
			stopped, evicted,
		}
	}

	const dispose = webServer.register({
		kind: 'exact',
		path: '/dsh-shredder/delete',
		handler: async (req, res) => {
			try {
				const body = req.method === 'GET' ? {} : await readJson(req)
				sendJson(res, 200, await deleteHandler(body))
			} catch (error) {
				sendJson(res, 500, { ok: false, reason: 'error', message: messageOf(error) })
			}
		},
	})
	ctx.effect(() => dispose, 'dsh-shredder routes')

	console.log('[shredder] persistent host half ready (1 route: delete)')
}
