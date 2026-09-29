/**
 * Standalone regression smoke for the client-half style-injection contract —
 * runs OUTSIDE the harness with a minimal DOM stub.
 *
 * Reproduces the host materialization sequence that made this plugin's sidebar
 * button render unstyled (2026-08): claimStyles (dsh-client-modules) retags
 * every untagged <style> in the document to whichever module is materializing,
 * so a foreign untagged tag can end up carrying OUR data-plugin attribute; an
 * attr-only injection guard then mistakes it for our own tag and skips the
 * real CSS forever. The host bookkeeping logic below is copied verbatim from
 * the installed runtime (@deepseek-ai/dsh 0.1.1-rc.2) — re-diff if the host
 * contract ever changes.
 *
 *   node test/style-injection.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const PLUGIN_ID = 'dsh-shredder';
const STYLE_ID = PLUGIN_ID + '-style';
const FOREIGN_ID = 'dsh-notification-style';

// ---- minimal DOM stub (only what lib/client.js + host bookkeeping touch) ----

class StyleEl {
	constructor(doc) {
		this.ownerDocument = doc;
		this.attributes = new Map();
		this.textContent = '';
		this.id = '';
	}
	get dataset() {
		const el = this;
		const toAttr = (prop) => 'data-' + String(prop).replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
		return new Proxy({}, {
			set(_, prop, value) { el.setAttribute(toAttr(prop), String(value)); return true; },
			get(_, prop) { return el.getAttribute(toAttr(prop)); }
		});
	}
	setAttribute(name, value) { this.attributes.set(name, String(value)); if (name === 'id') this.id = String(value); }
	getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
	remove() {
		const head = this.ownerDocument.headChildren;
		const at = head.indexOf(this);
		if (at !== -1) head.splice(at, 1);
	}
}

function bootPage() {
	const doc = {
		headChildren: [],
		head: null,
		createElement(tag) {
			if (tag !== 'style') throw new Error('stub only supports <style>, got ' + tag);
			return new StyleEl(doc);
		},
		getElementById(id) { return doc.headChildren.find((el) => el.id === id) ?? null; },
		querySelector(sel) { return doc.querySelectorAll(sel)[0] ?? null; },
		querySelectorAll(sel) {
			const plain = /^style\[data-plugin="([^"]*)"\]$/.exec(sel);
			const anyTagged = sel === 'style[data-plugin]';
			const untagged = sel === 'style:not([data-plugin])';
			if (!plain && !anyTagged && !untagged) throw new Error('stub selector unsupported: ' + sel);
			return doc.headChildren.filter((el) => el.tagNameOK && (plain
				? el.getAttribute('data-plugin') === plain[1]
				: anyTagged
					? el.getAttribute('data-plugin') !== null
					: el.getAttribute('data-plugin') === null));
		}
	};
	doc.head = {
		append: (...els) => { for (const el of els) { el.tagNameOK = true; doc.headChildren.push(el); } },
		appendChild: (el) => { doc.head.append(el); return el; }
	};
	const registrations = [];
	const sandbox = {
		window: { __ModuleLoader__: { mode: 'queue', load: (reg) => registrations.push(reg) } },
		document: doc,
		require(spec) {
			if (spec === 'react') return { createElement: () => { throw new Error('rendering not exercised in this smoke'); } };
			throw new Error('unexpected require: ' + spec);
		}
	};
	vm.createContext(sandbox);
	vm.runInContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), sandbox);
	return { doc, registrations, require: sandbox.require };
}

// ---- host bookkeeping, verbatim from @deepseek-ai/dsh 0.1.1-rc.2 ----

// dsh-client-modules materialize(): factory first, then claim untagged styles.
function claimStyles(doc, id) {
	for (const el of doc.querySelectorAll('style:not([data-plugin])')) el.setAttribute('data-plugin', id);
	const owned = [];
	for (const el of doc.querySelectorAll(`style[data-plugin=${JSON.stringify(id)}]`)) owned.push(el.getAttribute('data-plugin-css') ?? id);
	return owned;
}

// dsh-client-hmr reload(): removes every tag carrying our attribute verbatim.
function removeOwnedStyles(doc, id) {
	for (const el of doc.querySelectorAll('style[data-plugin]')) if (el.getAttribute('data-plugin') === id) el.remove();
}

// Simulate a pre-fix dsh-notification apply(): untagged style in head.
function seedUntaggedForeignStyle(doc) {
	const el = doc.createElement('style');
	el.id = FOREIGN_ID;
	el.textContent = '.dsh_notification_section{display:flex}';
	doc.head.appendChild(el);
	return el;
}

// materialize + start, in the host's order.
function materializeAndApply(page) {
	const reg = page.registrations[0];
	assert.equal(reg.id, PLUGIN_ID, 'plugin must register under its package id');
	const exports = reg.factory(page.require); // materialize step 1: factory body
	claimStyles(page.doc, reg.id);             // materialize step 2: host claims
	exports.apply({                            // cordis start
		get(key) {
			if (key === 'slots') return {
				inject(name, fn) { fn(); },
				register(meta, component) { return component; }
			};
			return undefined;
		}
	});
	return exports;
}

const cssOf = (doc) => doc.headChildren.map((el) => el.textContent).join('\n');

// ---- S0: CSS lands at factory time (materialization), pre-tagged ----
{
	const page = bootPage();
	const reg = page.registrations[0];
	reg.factory(page.require);
	const ours = page.doc.getElementById(STYLE_ID);
	assert(ours, 'factory body must inject the stylesheet (convention A1: materialization-time)');
	assert.equal(ours.getAttribute('data-plugin'), PLUGIN_ID, 'tag must carry data-plugin for HMR bookkeeping');
	assert.ok(ours.textContent.includes('.shred-item'), 'injected text must be the real CSS');
	console.log('S0 ok — factory-time injection, pre-tagged');
}

// ---- S1 THE BUG: foreign untagged tag gets retagged to our name ----
{
	const page = bootPage();
	seedUntaggedForeignStyle(page.doc);
	materializeAndApply(page);
	const stolen = page.doc.getElementById(FOREIGN_ID);
	assert.equal(stolen?.getAttribute('data-plugin'), PLUGIN_ID, 'precondition: host retagged the foreign tag to us');
	const ours = page.doc.getElementById(STYLE_ID);
	assert(ours, 'our tag must exist by id even though a foreign tag now carries our data-plugin');
	assert.ok(cssOf(page.doc).includes('.shred-item'), 'real CSS must land — attr-only guard skipped it before the fix');
	assert.equal(ours.getAttribute('data-plugin'), PLUGIN_ID);
	assert.ok(stolen.textContent.includes('.dsh_notification_section'), 'foreign CSS must survive the retag');
	console.log('S1 ok — claim-theft no longer starves the real CSS');
}

// ---- S2: repeated apply (fiber restart) must not duplicate the tag ----
{
	const page = bootPage();
	const exports = materializeAndApply(page);
	exports.apply({ get: () => undefined }); // restart without re-materialize
	const ours = page.doc.querySelectorAll(`style[data-plugin="${PLUGIN_ID}"]`);
	assert.equal(ours.length, 1, 'exactly one owned tag after re-apply');
	assert.equal(page.doc.getElementById(STYLE_ID), ours[0], 'id guard keeps the original tag');
	console.log('S2 ok — idempotent across re-apply');
}

// ---- S3: HMR reload (styles wiped, module invalidated) restores CSS ----
{
	const page = bootPage();
	seedUntaggedForeignStyle(page.doc);
	materializeAndApply(page);
	removeOwnedStyles(page.doc, PLUGIN_ID); // host wipes every tag wearing our name
	assert.equal(page.doc.getElementById(STYLE_ID), null, 'precondition: styles wiped by HMR');
	// rebuilt frame: invalidate → prefetch (re-register) → refresh (materialize+start)
	page.registrations.push(page.registrations[0]); // prefetched bundle re-registers
	page.registrations.shift();
	materializeAndApply(page);
	assert.ok(cssOf(page.doc).includes('.shred-item'), 'CSS must come back after an HMR reload');
	console.log('S3 ok — CSS restored after HMR-style wipe + re-materialize');
}

console.log('style-injection smoke: all scenarios green');
