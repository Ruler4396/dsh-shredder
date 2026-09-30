window.__ModuleLoader__.load({ id: 'dsh-shredder', factory: (require) => { var module = { exports: {} }; var exports = module.exports;
// dsh-shredder — browser half
// 原生会话行的 "..." 菜单里加一枚红色「彻底删除」，排在官方"取消归档"之后，且只在
// 该会话已归档时出现（归档会话保留成员槽位，官方视图已把它们显示在所属工作区下，
// 本插件不再自建面板）。点击走宿主半的 /dsh-shredder/delete。
// 行的 DOM 与配色逐条对齐官方 primitives MenuItemButton（div.itemWrap > button[role
// =menuitem].item.danger + span.itemIcon + span.itemLabel）——primitives 是构建期
// 依赖、不在 client 模块表里，所以这里复刻形状而不是 require 它。

var React = require('react');
var h = React.createElement;

var PLUGIN_ID = 'dsh-shredder';
var DELETE_PATH = '/dsh-shredder/delete';

var CSS_TEXT = [
	'.shred-itemWrap{position:relative}',
	'.shred-item{display:flex;align-items:center;gap:6px;width:100%;min-height:34px;padding:6px 8px;border:none;border-radius:var(--dsw-radius-md);background:transparent;cursor:pointer;font-family:inherit;font-size:13px;line-height:20px;text-align:left;color:var(--dsw-alias-state-error-primary)}',
	'.shred-item:hover:not(:disabled),.shred-item:focus-visible:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger);outline:none}',
	'.shred-item:disabled{opacity:.4;cursor:not-allowed}',
	'.shred-itemIcon{display:inline-flex;flex:none;width:14px;height:14px;align-items:center;justify-content:center;color:var(--dsw-alias-state-error-primary)}',
	'.shred-itemIcon svg{width:14px;height:14px}',
	'.shred-itemLabel{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
].join('\n');

// 样式注入守约：factory 顶层（模块物化期）就注入，标签同时带 id + data-plugin，
// 防重复守卫只认自家 id。宿主 dsh-client-modules 的 claimStyles 会在模块物化时把
// document 里所有未打标 <style> 改姓给当前模块，data-plugin 属性可能被顶到外来标签
// 上——只查该属性会把真 CSS 永远挡在门外；data-plugin 仍须预打标，dsh-client-hmr
// 按它卸载样式。
var STYLE_ID = PLUGIN_ID + '-style';
function injectStyles() {
	if (document.getElementById(STYLE_ID) !== null) return;
	var tag = document.createElement('style');
	tag.id = STYLE_ID;
	tag.dataset.plugin = PLUGIN_ID;
	tag.textContent = CSS_TEXT;
	document.head.append(tag);
}
injectStyles();

var IconTrash = function () { return h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' },
	h('path', { d: 'M3 6h18' }),
	h('path', { d: 'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2' }),
	h('path', { d: 'M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6' })); };

function postDelete(sessionId) {
	return fetch(DELETE_PATH, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ sessionId: sessionId })
	}).then(function (res) { return res.json(); });
}

function labelOf(phase, detail) {
	if (phase === 'confirm') return '确认彻底删除';
	if (phase === 'busy') return '删除中…';
	if (phase === 'held') return detail;
	if (phase === 'error') return '删除失败：' + detail;
	return '彻底删除';
}

// 文件已删、归档标记被宿主故意暂留：这一行在各标签页里还没消失，此时清标记会让它
// 跳进普通列表并显示"历史加载失败"。所以先让本页重拉官方会话列表（客户端 sessions
// 服务的 refresh()：全量走 session.list，且它把旧基线**按新列表过滤**，所以消失的
// 会话会被摘掉），确认刷新过之后再补清记录。没有 refresh 就维持暂留文案。
function finishHeldDelete(sessionId, deps) {
	return Promise.resolve().then(function () {
		if (typeof deps.refresh !== 'function') throw new Error('no-session-refresh');
		return deps.refresh();
	}).then(function () { return deps.post(sessionId); }).then(function (result) {
		if (result && result.ok === true) { deps.close(); return; }
		deps.held(result);
	}).catch(function () { deps.held(null); });
}

function heldText(result) {
	if (result && result.evicted === 'deferred') return '已删除，正在收尾…';
	return '已删除，重载页面后消失';
}

// apply() 里解析：客户端 sessions 服务（ClientSessions）的 refresh()。
var sessionsRefresh = null;

function DeleteArchivedMenuItem(props) {
	var sessionId = props.sessionId;
	var useMenuOpenState = props.useMenuOpenState;
	var useWorkspaces = props.useWorkspaces;
	if (typeof useWorkspaces !== 'function' || typeof useMenuOpenState !== 'function') return null;
	var menuState = useMenuOpenState();
	var menuOpen = menuState[0];
	var setMenuOpen = menuState[1];
	var archived = useWorkspaces(function (snapshot) {
		var ids = snapshot.archivedSessionIds;
		return Array.isArray(ids) && ids.indexOf(sessionId) !== -1;
	});
	var phaseState = React.useState('idle');
	var phase = phaseState[0], setPhase = phaseState[1];
	var detailState = React.useState('');
	var detail = detailState[0], setDetail = detailState[1];

	// 菜单收起即回到待点击态：确认状态不跨次打开留存（'held' 是终态，跟着组件一起消失）。
	React.useEffect(function () {
		if (!menuOpen && phase !== 'idle' && phase !== 'held') setPhase('idle');
	}, [menuOpen]);

	if (!archived) return null;

	var onSelect = function () {
		if (phase === 'busy' || phase === 'held') return;
		if (phase !== 'confirm') { setDetail(''); setPhase('confirm'); return; }
		setPhase('busy');
		var fail = function (result) {
			setDetail(detailOf(result));
			setPhase('error');
		};
		postDelete(sessionId).then(function (result) {
			if (result && result.ok === true) {
				if (result.recordHeld !== true) { setMenuOpen(false); return undefined; }
				return finishHeldDelete(sessionId, {
					refresh: sessionsRefresh,
					post: postDelete,
					close: function () { setMenuOpen(false); },
					held: function (second) { setDetail(heldText(second || result)); setPhase('held'); },
				});
			}
			return fail(result);
		}).catch(function (error) {
			fail({ ok: false, reason: 'error', message: String((error && error.message) || error) });
		});
	};

	return h('div', { className: 'shred-itemWrap' }, h('button', {
		type: 'button',
		role: 'menuitem',
		className: 'shred-item',
		disabled: phase === 'busy' || phase === 'held',
		title: phase === 'held'
			? '会话文件已经删除；这一行还没从各标签页消失，所以归档标记先留着（宿主会在后台复查里补清）'
			: '物理删除该会话的整个日志目录，不可恢复',
		onClick: onSelect
	},
		h('span', { className: 'shred-itemIcon' }, IconTrash()),
		h('span', { className: 'shred-itemLabel' }, labelOf(phase, detail))));
}

// 失败时把宿主的诊断一起写出来：光一个 `unknown` 分不清「日志不在场」和「宿主没挂上」。
function detailOf(result) {
	var base = (result && (result.message || result.reason)) || '未知错误';
	if (result && result.reason === 'unknown') base += '（日志不在场；驻留实例=' + result.evicted + '）';
	return String(base);
}

function apply(ctx) {
	injectStyles(); // 幂等兜底：正常路径已由 factory 顶层注入
	var slots = ctx.get('slots');
	if (slots === undefined) return;
	var sessions = ctx.get('sessions');
	sessionsRefresh = sessions !== undefined && typeof sessions.refresh === 'function'
		? function () { return sessions.refresh(); }
		: null;
	// 官方菜单行序：pin 100 / rename 200 / fork 300 / archive 400 ⇒ 450 落在"取消归档"下。
	slots.inject('sidebar.workspaces.session.menu.item', function () { return slots.register({
		name: 'sidebar.workspaces.session.menu.item',
		id: 'shredder',
		order: 450,
		label: '彻底删除'
	}, DeleteArchivedMenuItem); });
	console.log('[shredder] persistent client half ready (session-list refresh ' + (sessionsRefresh === null ? 'unavailable' : 'available') + ')');
}

module.exports = { apply: apply, inject: ['slots'], finishHeldDelete: finishHeldDelete };
return module.exports; } });
