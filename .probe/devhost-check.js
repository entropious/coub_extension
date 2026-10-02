// Опрос расширения в Extension Development Host через CDP.
// Используется из devhost.sh; напрямую: node .probe/devhost-check.js <команда>
//
//   targets              список CDP-таргетов окна
//   layout               раскладка окна: нижняя панель, вкладки редактора
//   cmd <название>       команда палитры
//   views                плееры с местом, где они живут (панель или вкладка)
//   wait <место> [сек]   дождаться загруженного коуба в панели или вкладке
//   click <место> <sel>  клик по элементу страницы плеера
//   eval <место> <выр>   произвольное выражение в контексте страницы плеера

const PORT = process.env.CDP_PORT || 9224;

async function targets() {
	const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
	return res.json();
}

/** Само окно VS Code — страница workbench, в которой живут панель и вкладки. */
async function workbenchTarget() {
	const list = await targets();
	const found = list.find(t => t.type === 'page' && (t.url || '').includes('workbench') && t.webSocketDebuggerUrl);
	if (!found) throw new Error('окно VS Code не найдено');
	return found;
}

/**
 * Обёртки вебвью с местом, где они живут: у вида в нижней панели в адресе
 * стоит purpose=webviewView, у вкладки редактора — нет.
 */
async function placedWebviews() {
	const list = await targets();
	return list
		.filter(t => (t.url || '').startsWith('vscode-webview://') && (t.url || '').includes('index.html')
			&& t.type !== 'service_worker' && t.webSocketDebuggerUrl)
		.map(target => ({
			where: (target.url || '').includes('purpose=webviewView') ? 'panel' : 'tab',
			target
		}));
}

async function webviewAt(where) {
	const found = (await placedWebviews()).find(w => w.where === where);
	if (!found) throw new Error(`вебвью (${where}) не найдено`);
	return found.target;
}

function evaluate(wsUrl, expression, timeoutMs = 30000) {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(wsUrl);
		const timer = setTimeout(() => { ws.close(); reject(new Error('таймаут CDP')); }, timeoutMs);
		const done = fn => value => { clearTimeout(timer); ws.close(); fn(value); };

		ws.onopen = () => ws.send(JSON.stringify({
			id: 1,
			method: 'Runtime.evaluate',
			params: { expression, awaitPromise: true, returnByValue: true, userGesture: true }
		}));

		ws.onmessage = event => {
			const msg = JSON.parse(event.data);
			if (msg.id !== 1) return;
			if (msg.error) return done(reject)(new Error(JSON.stringify(msg.error)));
			if (msg.result?.exceptionDetails) {
				const details = msg.result.exceptionDetails;
				return done(reject)(new Error(details.text + ' ' + (details.exception?.description || '')));
			}
			done(resolve)(msg.result?.result?.value);
		};

		ws.onerror = () => { clearTimeout(timer); reject(new Error('ошибка соединения CDP')); };
	});
}

/** Страница расширения лежит во вложенном фрейме обёртки вебвью. */
function inFrame(body) {
	return `(() => {
		const frame = document.querySelector('iframe');
		const win = frame && frame.contentWindow;
		const doc = win && win.document;
		if (!doc || !doc.body) return { ready: false };
		return (${body})(doc, win);
	})()`;
}

const READ_PLAYER = inFrame(`(doc) => {
	const video = doc.getElementById('coub-video');
	const title = doc.getElementById('coub-title');
	return {
		ready: true,
		есть_кнопка_Tab: Boolean(doc.getElementById('tab-btn')),
		заголовок: title ? title.textContent : null,
		пауза: video ? video.paused : null,
		видео: video ? video.src : null
	};
}`);

async function readPlayer(where) {
	const target = await webviewAt(where);
	return evaluate(target.webSocketDebuggerUrl, READ_PLAYER);
}

async function views() {
	const placed = await placedWebviews();
	const out = [];
	for (const { where, target } of placed) {
		out.push({ where, ...(await evaluate(target.webSocketDebuggerUrl, READ_PLAYER)) });
	}
	return out;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Коуб считается загруженным, когда у плеера есть поток и заголовок. */
async function waitForCoub(where, seconds = 40) {
	const deadline = Date.now() + seconds * 1000;
	let last = null;
	while (Date.now() < deadline) {
		try {
			last = await readPlayer(where);
			if (last.ready && last.видео && last.заголовок && last.заголовок !== 'Loading...') return last;
		} catch (err) {
			last = { ошибка: String(err.message || err) };
		}
		await sleep(1500);
	}
	throw new Error(`коуб в ${where} не загрузился за ${seconds} с: ${JSON.stringify(last)}`);
}

async function clickIn(where, selector) {
	const target = await webviewAt(where);
	return evaluate(target.webSocketDebuggerUrl, inFrame(`(doc) => {
		const el = doc.querySelector(${JSON.stringify(selector)});
		if (!el) return { кликнуто: false, причина: 'элемент не найден' };
		el.click();
		return { кликнуто: true };
	}`));
}

async function readLayout() {
	const target = await workbenchTarget();
	return evaluate(target.webSocketDebuggerUrl, `(() => {
		const panel = document.querySelector('.part.panel');
		const shown = el => Boolean(el && el.offsetParent !== null && el.getBoundingClientRect().height > 0);
		const activePanelTab = document.querySelector('.part.panel .composite-bar .action-item.checked');
		return {
			нижняяПанельВидна: shown(panel),
			вкладкаПанели: activePanelTab ? activePanelTab.textContent.trim() : null,
			вкладкиРедактора: Array.from(document.querySelectorAll('.tab')).map(t => t.getAttribute('aria-label'))
		};
	})()`);
}

function dispatchKey(wsUrl, combo) {
	const parts = combo.split('+');
	const key = parts.pop();
	const bits = { alt: 1, ctrl: 2, cmd: 4, meta: 4, shift: 8 };
	const modifiers = parts.reduce((m, p) => m | (bits[p] || 0), 0);
	const named = { Enter: 13, Escape: 27, Tab: 9 };
	const keyCode = named[key] || key.toUpperCase().charCodeAt(0);
	const code = named[key] ? key : `Key${key.toUpperCase()}`;
	const event = type => ({ type, modifiers, key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(wsUrl);
		const timer = setTimeout(() => { ws.close(); reject(new Error('таймаут CDP')); }, 15000);
		ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Input.dispatchKeyEvent', params: event('rawKeyDown') }));
		ws.onmessage = e => {
			const msg = JSON.parse(e.data);
			if (msg.id === 1) return ws.send(JSON.stringify({ id: 2, method: 'Input.dispatchKeyEvent', params: event('keyUp') }));
			if (msg.id === 2) { clearTimeout(timer); ws.close(); resolve(); }
		};
		ws.onerror = () => { clearTimeout(timer); reject(new Error('ошибка соединения CDP')); };
	});
}

function insertText(wsUrl, text) {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(wsUrl);
		const timer = setTimeout(() => { ws.close(); reject(new Error('таймаут CDP')); }, 15000);
		ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Input.insertText', params: { text } }));
		ws.onmessage = e => {
			if (JSON.parse(e.data).id !== 1) return;
			clearTimeout(timer); ws.close(); resolve();
		};
		ws.onerror = () => { clearTimeout(timer); reject(new Error('ошибка соединения CDP')); };
	});
}

/**
 * Команда редактора идёт только через палитру, и перед ней фокус забирается у
 * вебвью кликом по статусной строке — иначе набранное уходит в страницу.
 */
async function runCommand(title) {
	const target = await workbenchTarget();
	const ws = target.webSocketDebuggerUrl;
	await evaluate(ws, `(() => {
		const bar = document.querySelector('.statusbar');
		if (bar) bar.click();
		return true;
	})()`);
	await dispatchKey(ws, 'cmd+shift+P');
	await sleep(600);
	await insertText(ws, title);
	await sleep(900);
	await dispatchKey(ws, 'Enter');
	await sleep(1200);
	return { команда: title };
}

async function main() {
	const [command, ...rest] = process.argv.slice(2);
	switch (command) {
		case 'targets':
			return (await targets()).map(t => ({ type: t.type, url: (t.url || '').slice(0, 120), parentId: t.parentId }));
		case 'layout':
			return readLayout();
		case 'cmd':
			return runCommand(rest.join(' '));
		case 'views':
			return views();
		case 'wait':
			return waitForCoub(rest[0] || 'panel', Number(rest[1]) || 40);
		case 'click':
			return clickIn(rest[0], rest[1]);
		case 'eval':
			return evaluate((await webviewAt(rest[0])).webSocketDebuggerUrl, inFrame(`(doc, win) => (${rest.slice(1).join(' ')})`));
		default:
			throw new Error('команды: targets, layout, cmd, views, wait, click, eval');
	}
}

main().then(
	value => { console.log(JSON.stringify(value, null, 2)); },
	err => { console.error(String(err.message || err)); process.exit(1); }
);
