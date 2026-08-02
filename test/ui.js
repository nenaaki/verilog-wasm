// 回路エディタ (web/editor.html) の操作テスト。node test/ui.js
//
// headless Chrome を立ち上げて、CDP (Chrome DevTools Protocol) で *本物の*
// マウス・キーボード入力を送り込む。クリックの当たり判定や pointer capture、
// SVG の座標変換まで含めて確かめられるので、実際にここで見つかった不具合がある
// (可視の線が当たり判定を奪う / SVG 名前空間で表を作ると描画されない など)。
//
// 依存パッケージは足していない。Node 22 以降のグローバル WebSocket で CDP を
// 直接話し、ブラウザはシステムに入っている Chrome を使う。
// Chrome が見つからない環境ではスキップして正常終了する。
//
//   CHROME=/path/to/chrome node test/ui.js   … 場所を指定する
//   PORT=8123 node test/ui.js                … 静的サーバのポート

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT ?? 8123);
const CDP_PORT = Number(process.env.CDP_PORT ?? 9333);
const BASE = `http://localhost:${PORT}/web/editor.html`;

// ------------------------------------------------------------ Chrome を探す
const CANDIDATES = [
  process.env.CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  `${process.env.LOCALAPPDATA ?? ''}/Google/Chrome/Application/chrome.exe`,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
].filter(Boolean);

const chromePath = CANDIDATES.find((p) => existsSync(p));
if (!chromePath) {
  console.log('skip 回路エディタの操作テスト (Chrome が見つからない)');
  console.log('     CHROME=/path/to/chrome node test/ui.js で場所を指定できます');
  process.exit(0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------- 静的サーバを起動
const server = spawn(process.execPath, [join(ROOT, 'tools', 'serve.js')], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: 'ignore',
});

async function waitForServer() {
  for (let i = 0; i < 40; i++) {
    try {
      if ((await fetch(BASE)).ok) return true;
    } catch { /* まだ起動中 */ }
    await sleep(250);
  }
  return false;
}

if (!await waitForServer()) {
  console.log(`FAIL 静的サーバが起動しない (ポート ${PORT} が使われている?)`);
  server.kill();
  process.exit(1);
}

// ------------------------------------------------------------ Chrome を起動
const profile = mkdtempSync(join(tmpdir(), 'vwasm-ui-'));
const browser = spawn(chromePath, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  '--disable-extensions', '--window-size=1340,900',
  `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
  BASE,
], { stdio: 'ignore' });

function teardown() {
  try { browser.kill(); } catch { /* もう死んでいる */ }
  try { server.kill(); } catch { /* もう死んでいる */ }
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* 掴まれている */ }
}
process.on('exit', teardown);

// ---------------------------------------------------------------- CDP 接続
let target = null;
for (let i = 0; i < 60 && !target; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
    target = list.find((t) => t.type === 'page' && t.url.includes('editor.html'));
  } catch { /* まだ起動中 */ }
  if (!target) await sleep(250);
}
if (!target) {
  console.log('FAIL Chrome のページに接続できない');
  process.exit(1);
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let msgId = 0;
const pending = new Map();
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) {
    const { res, rej } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
  }
};
const send = (method, params = {}) => new Promise((res, rej) => {
  const n = ++msgId;
  pending.set(n, { res, rej });
  ws.send(JSON.stringify({ id: n, method, params }));
});

/** ページ内で式を評価して値をもらう */
const js = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    throw new Error(`ページ内例外: ${r.exceptionDetails.exception?.description ?? '不明'}`);
  }
  return r.result.value;
};

// ------------------------------------------------------------ 入力を送る
const SHIFT = 8, CTRL = 2;   // CDP の modifiers ビット

async function click(pos, modifiers = 0) {
  if (!pos) throw new Error('クリック対象の座標が取れない');
  const [x, y] = pos;
  const b = { x, y, button: 'left', clickCount: 1, modifiers };
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0, modifiers });
  await send('Input.dispatchMouseEvent', { ...b, type: 'mousePressed', buttons: 1 });
  await send('Input.dispatchMouseEvent', { ...b, type: 'mouseReleased', buttons: 0 });
  await sleep(120);
}

async function dragTo([x0, y0], [x1, y1], modifiers = 0) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0, y: y0, buttons: 0, modifiers });
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: x0, y: y0, button: 'left', clickCount: 1, buttons: 1, modifiers,
  });
  for (let i = 1; i <= 5; i++) {
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', button: 'left', buttons: 1, modifiers,
      x: x0 + (x1 - x0) * i / 5, y: y0 + (y1 - y0) * i / 5,
    });
  }
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: x1, y: y1, button: 'left', clickCount: 1, buttons: 0, modifiers,
  });
  await sleep(120);
}

async function wheel([x, y], deltaY, ctrl) {
  await send('Input.dispatchMouseEvent', {
    type: 'mouseWheel', x, y, deltaX: 0, deltaY, modifiers: ctrl ? CTRL : 0,
  });
  await sleep(120);
}

async function key(k, code, keyCode, modifiers = 0) {
  await send('Input.dispatchKeyEvent', {
    type: 'keyDown', key: k, code, windowsVirtualKeyCode: keyCode, modifiers,
  });
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: k, code, windowsVirtualKeyCode: keyCode, modifiers,
  });
  await sleep(140);
}

/** Ctrl + 英字。CDP は key/code/keyCode を揃えないと拾ってくれない */
const ctrlKey = (ch, extra = 0) =>
  key(ch, `Key${ch.toUpperCase()}`, ch.toUpperCase().charCodeAt(0), CTRL | extra);

const type = async (text) => { await send('Input.insertText', { text }); await sleep(60); };

// -------------------------------------------------- ページ内のヘルパ関数
// 部品や配線の位置は SVG の中にあるので、client 座標への変換はページ側でやる。
const HELPERS = `
  window.__nodeAt = (prefix) => [...document.querySelectorAll('#gNodes .node')]
    .find((g) => g.textContent.trim().startsWith(prefix));
  window.__center = (elm) => { const r = elm.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; };
  window.__btn = (id) => __center(document.getElementById(id));
  window.__nodeCenter = (prefix) => __center(__nodeAt(prefix));
  window.__pinCenter = (prefix, i) => { const ps = [...__nodeAt(prefix).querySelectorAll('.pin')];
    return __center(i < 0 ? ps[ps.length - 1] : ps[i]); };
  window.__button = (text) => __center([...document.querySelectorAll('#palette button')]
    .find((b) => b.textContent === text));
  // 線の当たり判定は部品の裏に隠れることがあるので、実際に拾える点を探す
  window.__wireHit = (n) => {
    const p = document.querySelectorAll('#gWires .wgroup')[n].querySelector('.wire');
    const m = document.getElementById('svg').getScreenCTM();
    for (const f of [0.5, 0.35, 0.65, 0.2, 0.8]) {
      const q = p.getPointAtLength(p.getTotalLength() * f);
      const s = new DOMPoint(q.x, q.y).matrixTransform(m);
      if (document.elementFromPoint(s.x, s.y)?.classList.contains('whit')) return [s.x, s.y];
    }
    return null;
  };
  // 部品も配線も無い場所 (背景ドラッグの起点用)
  window.__emptySpot = (fys = [0.9, 0.8, 0.15]) => {
    const r = document.getElementById('canvasWrap').getBoundingClientRect();
    for (const fy of fys) for (const fx of [0.1, 0.5, 0.9]) {
      const x = r.x + r.width * fx, y = r.y + r.height * fy;
      if (document.elementFromPoint(x, y)?.id === 'svg') return [x, y];
    }
    return null;
  };
  window.__corner = (fx, fy) => {
    const r = document.getElementById('canvasWrap').getBoundingClientRect();
    return [r.x + r.width * fx, r.y + r.height * fy];
  };
  window.__verilog = () => document.getElementById('verilog').textContent;
  window.__msg = () => document.getElementById('msg').textContent;
  window.__disabled = (id) => document.getElementById(id).disabled;
  window.__cyc = () => document.getElementById('cyc').textContent;
  window.__memText = () => [...document.querySelectorAll('#gNodes .node.reg')]
    .map((g) => g.textContent.trim())[0] ?? null;
  window.__nodeText = (prefix) => __nodeAt(prefix)?.textContent.trim() ?? null;
  // 幅 (バス)
  window.__widthBox = () => {
    const w = document.getElementById('bitWidth');
    return w.disabled ? null : w.value;
  };
  window.__setWidth = async (v) => {
    const w = document.getElementById('bitWidth');
    w.value = String(v);
    await w.onchange();
  };
  window.__valueBoxOpen = () => !!document.getElementById('renameBox');
  window.__typeValue = (text) => {
    const b = document.getElementById('renameBox');
    b.value = text;
    b.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  };
  window.__busVals = () => [...document.querySelectorAll('#waveSvg path[data-vals]')]
    .map((p) => p.dataset.sig + '=' + p.dataset.vals).join(' ');
  window.__nodeCount = () => document.querySelectorAll('#gNodes .node').length;
  window.__wireCount = () => document.querySelectorAll('#gWires .wgroup').length;
  window.__selCount = () => document.querySelectorAll('#gNodes .node.sel').length;
  window.__transform = (prefix) => __nodeAt(prefix).getAttribute('transform');
  window.__types = () => [...document.querySelectorAll('#gNodes .node')]
    .map((g) => g.textContent.trim()).sort().join(',');
  // 表
  window.__tableHead = () => document.getElementById('tableHead').textContent;
  window.__rows = () => [...document.querySelectorAll('#truth tr')];
  window.__truth = () => __rows().map((tr) => [...tr.children].map((td) => td.textContent).join('')).join('/');
  window.__rowCells = (i) => [...__rows()[i + 1].children].map((td) => td.textContent).join('');
  window.__nowRow = () => __rows().findIndex((tr) => tr.classList.contains('now')) - 1;
  // 波形
  window.__wave = (sig) => document.querySelector('#waveSvg path[data-sig="' + sig + '"]')?.dataset.bits ?? null;
  window.__waveSigs = () => [...document.querySelectorAll('#waveSvg path.sig')].map((p) => p.dataset.sig).join(',');
  window.__waveInfo = () => document.getElementById('waveInfo').textContent;
  // カーソル: 指している列と、そのとき名前の右に出る値
  window.__waveCursor = () => {
    const r = document.querySelector('#waveSvg rect.cursor');
    return r ? Number(r.dataset.col) : -1;
  };
  window.__waveVals = () => [...document.querySelectorAll('#waveNames text.val')]
    .map((t) => t.dataset.sig + '=' + t.dataset.val).join(',');
  /** 波形の c 列目の中心の client 座標 */
  window.__waveColPoint = (c) => {
    const r = document.getElementById('waveSvg').getBoundingClientRect();
    return [r.x + c * 26 + 13, r.y + r.height / 2];
  };
  window.__waveH = () => document.getElementById('wavePanel').getBoundingClientRect().height;
  // 表示範囲とパネル
  window.__viewBox = () => document.getElementById('svg').getAttribute('viewBox');
  window.__viewW = () => Number(__viewBox().split(' ')[2]);
  window.__asideW = () => document.getElementById('aside').getBoundingClientRect().width;
  window.__verilogH = () => document.getElementById('verilog').parentElement.getBoundingClientRect().height;
  window.__truthH = () => document.getElementById('truth').parentElement.getBoundingClientRect().height;
  // 回路の出し入れ
  window.__options = () => [...document.getElementById('presets').options].map((o) => o.value).join('|');
  window.__selected = () => document.getElementById('presets').value;
  window.__cname = () => document.getElementById('cname').value;
  window.__setName = (v) => { document.getElementById('cname').value = v; };
  window.__saved = () => Object.keys(JSON.parse(localStorage.getItem('verilog-wasm/saved') ?? '{}')).join(',');
  window.__work = () => localStorage.getItem('verilog-wasm/work');
  window.__hash = () => location.hash;
  window.__preset = (part) => { const s = document.getElementById('presets');
    s.value = [...s.options].map((o) => o.value).find((v) => v.includes(part));
    s.dispatchEvent(new Event('change')); return s.value; };
  window.__renameBoxOpen = () => !!document.getElementById('renameBox');
  // 出力端子の client 座標 (入力端子は cx=0、出力端子は cx>0 に置いている)
  window.__outPinPoint = (nodeId, port) => {
    const g = document.querySelector('#gNodes .node[data-id="' + nodeId + '"]');
    const outs = [...g.querySelectorAll('.pin')].filter((c) => Number(c.getAttribute('cx')) > 0);
    const r = outs[port].getBoundingClientRect();
    return [r.x + r.width / 2, r.y + r.height / 2];
  };
  // 配線の始点が駆動元の端子とずれていないか (ずれているものを返す)
  window.__wireStartMismatch = () => {
    const m = document.getElementById('svg').getScreenCTM();
    const bad = [];
    for (const g of document.querySelectorAll('#gWires .wgroup')) {
      const [id, port] = g.dataset.from.split(':').map(Number);
      const path = g.querySelector('.wire');
      const a = path.getPointAtLength(0);
      const s = new DOMPoint(a.x, a.y).matrixTransform(m);
      const [px, py] = __outPinPoint(id, port);
      if (Math.abs(s.x - px) > 2 || Math.abs(s.y - py) > 2) {
        bad.push(g.dataset.from + ' が y で ' + Math.round(s.y - py) + 'px ずれている');
      }
    }
    return bad.join(' / ');
  };
  window.__wireFroms = () => [...document.querySelectorAll('#gWires .wgroup')]
    .map((g) => g.dataset.from).sort().join(',');
  // 回路部品
  window.__blockCount = () => document.querySelectorAll('#gNodes .node.blk').length;
  window.__blockLabels = () => [...document.querySelectorAll('#gNodes .node.blk text.blkname')]
    .map((t) => t.textContent).join(',');
  window.__pinLabels = () => [...document.querySelectorAll('#gNodes .node.blk text.pinlab')]
    .map((t) => t.textContent).join(',');
  window.__blockPins = () => document.querySelectorAll('#gNodes .node.blk .pin').length;
  window.__setPick = (v) => { document.getElementById('blockPick').value = v; };
  window.__pickOptions = () => [...document.getElementById('blockPick').options]
    .map((o) => o.value).join('|');
  // ブロックの n 個目の入力端子 / 出力端子 (端子は入力→出力の順に描いている)
  window.__blockPin = (kind, i, nIn) => {
    const pins = [...document.querySelector('#gNodes .node.blk').querySelectorAll('.pin')];
    const p = kind === 'in' ? pins[i] : pins[nIn + i];
    const r = p.getBoundingClientRect();
    return [r.x + r.width / 2, r.y + r.height / 2];
  };
  window.__blockAt = (n) => {
    const g = document.querySelectorAll('#gNodes .node.blk')[n];
    const r = g.getBoundingClientRect();
    return [r.x + r.width / 2, r.y + r.height / 2];
  };
  window.__blockPinOf = (n, kind, i, nIn) => {
    const pins = [...document.querySelectorAll('#gNodes .node.blk')[n].querySelectorAll('.pin')];
    const p = kind === 'in' ? pins[i] : pins[nIn + i];
    const r = p.getBoundingClientRect();
    return [r.x + r.width / 2, r.y + r.height / 2];
  };
  true;
`;

/** エディタが動き出すのを待ってからヘルパを流し込む (読み込み前に入れても消える) */
async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try {
      if (await js('!!document.getElementById("presets") && !!document.getElementById("msg").textContent')) {
        await js(HELPERS);
        return true;
      }
    } catch { /* まだ読み込み中 */ }
    await sleep(250);
  }
  return false;
}

let navCount = 0;
/** 本当にページを読み直す (ハッシュだけ変えても再読み込みされないため) */
async function reopen(hash = '') {
  await send('Page.navigate', { url: `${BASE}?t=${++navCount}${hash}` });
  await sleep(700);
  await waitReady();
  await sleep(300);
}

// ------------------------------------------------------------------ 記録
let passed = 0;
const failures = [];
const ok = (cond, label, detail = '') =>
  cond ? passed++ : failures.push(`${label}${detail ? ` — ${detail}` : ''}`);

await send('Page.enable');
if (!await waitReady()) {
  console.log('FAIL エディタが読み込まれない');
  process.exit(1);
}
await sleep(400);

// ==================================================== 初期状態 (AND ゲート)
await js('__preset("AND")');
await sleep(400);
ok((await js('__verilog()')).includes('assign n3 = a & b;'), '初期: AND の assign が出る', await js('__verilog()'));
ok((await js('__msg()')).includes('コンパイル成功'), '初期: コンパイル成功', await js('__msg()'));
ok(await js('__truth()') === 'aby0/000/100/010/111', '初期: 真理値表が AND', await js('__truth()'));
ok(await js('__nodeText("a")') === 'a1', '初期: 入力 a は 1', await js('__nodeText("a")'));
ok(await js('__nodeText("b")') === 'b0', '初期: 入力 b は 0', await js('__nodeText("b")'));
ok(await js('__nodeText("y0")') === 'y00', '初期: 出力 y0 は 0', await js('__nodeText("y0")'));

// ==================================================== 入力のクリックで反転
await click(await js('__nodeCenter("b")'));
ok(await js('__nodeText("b")') === 'b1', 'クリック: b が 1 になる', await js('__nodeText("b")'));
ok(await js('__nodeText("y0")') === 'y01', 'クリック: 1&1 で出力が点灯', await js('__nodeText("y0")'));
await click(await js('__nodeCenter("a")'));
ok(await js('__nodeText("a")') === 'a0', 'クリック: a が 0 になる', await js('__nodeText("a")'));
ok(await js('__nodeText("y0")') === 'y00', 'クリック: 0&1 で消灯', await js('__nodeText("y0")'));
await click(await js('__nodeCenter("a")'));   // a=1, b=1 に戻す

// ==================================================== 線をクリックで切断
await click(await js('__wireHit(2)'));        // AND → 出力 の線
ok(await js('__wireCount()') === 2, '切断: 配線が 1 本消える', String(await js('__wireCount()')));
ok(!(await js('__verilog()')).includes('assign y0'), '切断: 未接続の出力は Verilog から消える', await js('__verilog()'));
ok((await js('__msg()')).includes('未配線'), '切断: 未配線の警告が出る', await js('__msg()'));
ok(await js('__nodeText("y0")') === 'y0', '切断: 出力の値は不明表示になる', await js('__nodeText("y0")'));

// ==================================================== 端子クリックで再配線
await click(await js('__pinCenter("AND", -1)'));      // AND の出力端子
await click(await js('__pinCenter("y0", 0)'));        // 出力部品の入力端子
ok(await js('__wireCount()') === 3, '配線: 端子→端子で 1 本増える', String(await js('__wireCount()')));
ok((await js('__verilog()')).includes('assign y0 = n3;'), '配線: Verilog に反映される', await js('__verilog()'));
ok(await js('__nodeText("y0")') === 'y01', '配線: 1&1 の結果が伝わる', await js('__nodeText("y0")'));

// ============================================== 入力端子は 1 本だけ (上書き)
await click(await js('__pinCenter("a", -1)'));        // 入力 a の出力端子
await click(await js('__pinCenter("y0", 0)'));        // 既に繋がっている端子へ
ok(await js('__wireCount()') === 3, '上書き: 配線は増えない', String(await js('__wireCount()')));
ok((await js('__verilog()')).includes('assign y0 = a;'), '上書き: 新しい駆動元に変わる', await js('__verilog()'));
await click(await js('__pinCenter("AND", -1)'));
await click(await js('__pinCenter("y0", 0)'));        // AND 経由に戻す

// ==================================================== 部品の追加と削除
await click(await js('__button("XOR")'));
ok(await js('__nodeCount()') === 5, '追加: XOR が増える', String(await js('__nodeCount()')));
ok((await js('__msg()')).includes('未配線'), '追加: 未配線として除外される', await js('__msg()'));
await key('Delete', 'Delete', 46);                   // 追加直後は選択されている
ok(await js('__nodeCount()') === 4, '削除: Delete キーで消える', String(await js('__nodeCount()')));
ok((await js('__msg()')).includes('コンパイル成功') && !(await js('__msg()')).includes('未配線'),
  '削除: 警告が消える', await js('__msg()'));

// ============================================== 入力を足すと真理値表が広がる
await click(await js('__button("入力")'));
ok((await js('__verilog()')).includes('input  c'), '追加: 3 つめの入力が宣言される', await js('__verilog()'));
ok((await js('__truth()')).startsWith('abcy0/'), '追加: 真理値表が 3 入力になる', await js('__truth()'));
ok((await js('__truth()')).split('/').length === 1 + 8, '追加: 8 行になる', await js('__truth()'));

// ==================================================== ドラッグで移動
const posBefore = await js('__transform("AND")');
await dragTo(await js('__nodeCenter("AND")'), [430, 700]);
ok(posBefore !== await js('__transform("AND")'), 'ドラッグ: 部品が移動する',
  `${posBefore} → ${await js('__transform("AND")')}`);
ok(await js('__wireCount()') === 3, 'ドラッグ: 配線は保たれる', String(await js('__wireCount()')));
ok(await js('__nodeText("y0")') === 'y01', 'ドラッグ: 値は変わらない (クリック扱いにならない)', await js('__nodeText("y0")'));

// ==================================================== Ctrl + ホイールで拡大縮小
await click(await js('__btn("fit")'));
ok(await js('__viewBox()') === '0 0 900 480', 'ズーム: 初期の viewBox', await js('__viewBox()'));
await wheel(await js('__nodeCenter("y0")'), -300, false);
ok(await js('__viewBox()') === '0 0 900 480', 'ズーム: Ctrl なしでは変わらない', await js('__viewBox()'));

const y0Before = await js('__nodeCenter("y0")');
await wheel(y0Before, -300, true);
const zoomedW = await js('__viewW()');
ok(zoomedW < 900, 'ズーム: Ctrl + ホイール上で拡大する', String(zoomedW));
const y0After = await js('__nodeCenter("y0")');
const drift = Math.hypot(y0After[0] - y0Before[0], y0After[1] - y0Before[1]);
ok(drift < 3, 'ズーム: カーソル下の点が動かない', `ずれ ${drift.toFixed(1)}px`);
ok(await js('__nodeText("y0")') === 'y01', 'ズーム: 回路の状態は変わらない', await js('__nodeText("y0")'));

await wheel(await js('__nodeCenter("y0")'), 900, true);
ok(await js('__viewW()') > zoomedW, 'ズーム: ホイール下で縮小する', String(await js('__viewW()')));

for (let i = 0; i < 20; i++) await wheel([400, 400], -600, true);
ok(Math.abs(await js('__viewW()') - 900 / 8) < 1, 'ズーム: 拡大の上限は 8 倍', String(await js('__viewW()')));
for (let i = 0; i < 40; i++) await wheel([400, 400], 600, true);
ok(Math.abs(await js('__viewW()') - 900 * 4) < 1, 'ズーム: 縮小の下限は 1/4', String(await js('__viewW()')));

await click(await js('__btn("fit")'));
ok(await js('__viewBox()') === '0 0 900 480', 'リセット: 初期表示に戻る', await js('__viewBox()'));

// ============================================ Shift + 背景ドラッグでスクロール
const spot = await js('__emptySpot()');
ok(spot !== null, '背景: 何もない場所が見つかる');
const nodesBefore = await js('__nodeCount()');
await dragTo(spot, [spot[0] - 120, spot[1] - 60], SHIFT);
const vb = (await js('__viewBox()')).split(' ').map(Number);
ok(vb[0] > 0 && vb[1] > 0, 'スクロール: Shift + ドラッグで表示位置が動く', await js('__viewBox()'));
ok(Math.abs(vb[2] - 900) < 0.01, 'スクロール: 倍率は変わらない', await js('__viewBox()'));
ok(await js('__nodeCount()') === nodesBefore, 'スクロール: 部品は増減しない', String(await js('__nodeCount()')));
await click(await js('__btn("fit")'));

// ==================================================== 区切りをつまんで動かす
const asideW0 = await js('__asideW()');
const splitV = await js('__btn("splitV")');
await dragTo(splitV, [splitV[0] - 150, 400]);
const asideW1 = await js('__asideW()');
ok(asideW1 - asideW0 > 130, '区切り(縦): 右のパネルが広がる', `${asideW0} → ${asideW1}`);
const splitV2 = await js('__btn("splitV")');
await dragTo(splitV2, [splitV2[0] + 150, 400]);
ok(Math.abs(await js('__asideW()') - asideW0) < 12, '区切り(縦): 戻せる',
  `${asideW0} → ${await js('__asideW()')}`);

const vh0 = await js('__verilogH()'), th0 = await js('__truthH()');
const splitH = await js('__btn("splitH")');
await dragTo(splitH, [splitH[0], splitH[1] + 100]);
ok(await js('__verilogH()') - vh0 > 80, '区切り(横): Verilog 側が高くなる',
  `${vh0} → ${await js('__verilogH()')}`);
ok(th0 - await js('__truthH()') > 80, '区切り(横): 真理値表側が低くなる',
  `${th0} → ${await js('__truthH()')}`);
const splitH2 = await js('__btn("splitH")');
await dragTo(splitH2, [1200, 20]);
ok(await js('__verilogH()') >= 40 && await js('__truthH()') >= 40, '区切り(横): 潰れない',
  `${await js('__verilogH()')} / ${await js('__truthH()')}`);

// ==================================================== 全部消す
await click(await js('__btn("clear")'));
ok(await js('__nodeCount()') === 0, '全部消す: 部品が無くなる', String(await js('__nodeCount()')));
ok((await js('__msg()')).includes('部品を置いて'), '全部消す: 案内が出る', await js('__msg()'));

// ============================================ 組合せ回路ではクロックを使わせない
await js('__preset("AND")');
await sleep(400);
ok(await js('__disabled("clock")') === true, 'クロック: 組合せ回路では押せない');
ok(await js('__cyc()') === '', 'クロック: カウンタは出ない', await js('__cyc()'));
ok((await js('__tableHead()')).includes('真理値表'), '表: 組合せなら真理値表', await js('__tableHead()'));

// ==================================================== 1 ビットメモリ
await js('__preset("反転")');
await sleep(500);
ok((await js('__verilog()')).includes('always @(posedge clk)'), 'メモリ: always が生成される', await js('__verilog()'));
ok((await js('__verilog()')).includes('output reg q,'), 'メモリ: output reg で宣言される', await js('__verilog()'));
ok(await js('__disabled("clock")') === false, 'メモリ: クロックが押せる');
ok(await js('__cyc()') === 'cyc=0', 'メモリ: カウンタが 0', await js('__cyc()'));
ok(await js('__memText()') === 'q0', 'メモリ: 中身は 0', await js('__memText()'));
ok((await js('__tableHead()')).includes('状態遷移表'), '表: メモリありなら状態遷移表', await js('__tableHead()'));
ok((await js('__truth()')).startsWith("qq'out/"), '表: 次状態の列が出る', await js('__truth()'));
ok((await js('__truth()')).split('/').length === 3, '表: 1 ビットなので 2 行', await js('__truth()'));
ok(await js('__rowCells(0)') === '010', '表: Q=0 なら次は 1・出力は 0', await js('__rowCells(0)'));
ok(await js('__rowCells(1)') === '101', '表: Q=1 なら次は 0・出力は 1', await js('__rowCells(1)'));
ok(await js('__nowRow()') === 0, '表: 今の状態の行に印が付く', String(await js('__nowRow()')));

await click(await js('__btn("clock")'));
ok(await js('__memText()') === 'q1', 'クロック: 1 回で反転する', await js('__memText()'));
ok(await js('__nodeText("out")') === 'out1', 'クロック: 出力にも伝わる', await js('__nodeText("out")'));
ok(await js('__cyc()') === 'cyc=1', 'クロック: カウンタが進む', await js('__cyc()'));
ok(await js('__nowRow()') === 1, 'クロック: 印の行が移る', String(await js('__nowRow()')));
await click(await js('__btn("clock")'));
ok(await js('__memText()') === 'q0', 'クロック: 2 回で戻る', await js('__memText()'));
ok(await js('__cyc()') === 'cyc=2', 'クロック: カウンタが 2', await js('__cyc()'));

await key(' ', 'Space', 32);
ok(await js('__memText()') === 'q1', 'クロック: Space でも打てる', await js('__memText()'));

// ==================================================== 波形
ok(await js('__waveSigs()') === 'q,out', '波形: メモリと出力の行が出る', await js('__waveSigs()'));
ok(await js('__wave("q")') === '0101', '波形: クロックごとに反転が記録される', await js('__wave("q")'));
ok(await js('__wave("out")') === '0101', '波形: 出力も同じ形', await js('__wave("out")'));
ok((await js('__waveInfo()')).includes('1 クロック'), '波形: 1 列 = 1 クロックと表示', await js('__waveInfo()'));

await js('document.getElementById("waveGates").click()');
await sleep(200);
ok(await js('__waveSigs()') === 'q,out,n2', '波形: 内部の配線も出せる', await js('__waveSigs()'));
ok(await js('__wave("n2")') === '1010', '波形: NOT の出力は反対の形', await js('__wave("n2")'));
await js('document.getElementById("waveGates").click()');
await sleep(200);
ok(await js('__waveSigs()') === 'q,out', '波形: 消せる', await js('__waveSigs()'));

await js('document.getElementById("nclk").value = 8');
await click(await js('__btn("clockN")'));
ok(await js('__wave("q")') === '010101010101', '波形: まとめて 8 クロック打てる', await js('__wave("q")'));
ok(await js('__cyc()') === 'cyc=11', '波形: カウンタも 8 進む', await js('__cyc()'));

// ---- カーソル (クリックした列の値を読む) ----
ok(await js('__waveCursor()') === -1, 'カーソル: 最初は出ていない');
ok(await js('__waveVals()') === '', 'カーソル: 値の列も空');

await click(await js('__waveColPoint(3)'));
ok(await js('__waveCursor()') === 3, 'カーソル: クリックした列に付く', String(await js('__waveCursor()')));
// q は 010101… なので 3 列目 (0 起点) は 1
ok(await js('__waveVals()') === 'q=1,out=1', 'カーソル: その列の値が出る', await js('__waveVals()'));
ok((await js('__waveInfo()')).includes('カーソル'), 'カーソル: 情報欄に列が出る', await js('__waveInfo()'));

await click(await js('__waveColPoint(4)'));
ok(await js('__waveCursor()') === 4, 'カーソル: 別の列に移せる', String(await js('__waveCursor()')));
ok(await js('__waveVals()') === 'q=0,out=0', 'カーソル: 値も追従する', await js('__waveVals()'));

await key('ArrowLeft', 'ArrowLeft', 37);
ok(await js('__waveCursor()') === 3, 'カーソル: ← で 1 列戻る', String(await js('__waveCursor()')));
ok(await js('__waveVals()') === 'q=1,out=1', 'カーソル: ← のあとの値', await js('__waveVals()'));
await key('ArrowRight', 'ArrowRight', 39);
ok(await js('__waveCursor()') === 4, 'カーソル: → で 1 列進む', String(await js('__waveCursor()')));

await key('ArrowLeft', 'ArrowLeft', 37);
await key('ArrowLeft', 'ArrowLeft', 37);
await key('ArrowLeft', 'ArrowLeft', 37);
await key('ArrowLeft', 'ArrowLeft', 37);
ok(await js('__waveCursor()') === 0, 'カーソル: 左端で止まる', String(await js('__waveCursor()')));

await click(await js('__waveColPoint(0)'));
ok(await js('__waveCursor()') === -1, 'カーソル: 同じ列をもう一度押すと外れる', String(await js('__waveCursor()')));

await click(await js('__waveColPoint(2)'));
await key('Escape', 'Escape', 27);
ok(await js('__waveCursor()') === -1, 'カーソル: Escape でも外れる', String(await js('__waveCursor()')));

// 内部の配線を出すと、その値もカーソルで読める
await js('document.getElementById("waveGates").click()');
await sleep(200);
await click(await js('__waveColPoint(3)'));
ok(await js('__waveVals()') === 'q=1,out=1,n2=0', 'カーソル: 内部の配線の値も読める', await js('__waveVals()'));
await js('document.getElementById("waveGates").click()');
await sleep(200);

await click(await js('__btn("waveClear")'));
ok(await js('__wave("q")') === '1', '波形: クリアすると今の値だけになる', await js('__wave("q")'));
ok(await js('__waveCursor()') === -1, 'カーソル: 波形をクリアすると外れる', String(await js('__waveCursor()')));

const wh0 = await js('__waveH()');
const splitW = await js('__btn("splitW")');
await dragTo(splitW, [splitW[0], splitW[1] - 80]);
ok(await js('__waveH()') - wh0 > 60, '波形: 区切りをつまんで高くできる',
  `${wh0} → ${await js('__waveH()')}`);

await click(await js('__btn("zero")'));
ok(await js('__memText()') === 'q0', 'クリア: メモリが 0 に戻る', await js('__memText()'));
ok(await js('__cyc()') === 'cyc=0', 'クリア: カウンタも戻る', await js('__cyc()'));

// ======================================== 書き込みイネーブル付きメモリ (保持)
await js('__preset("イネーブル")');
await sleep(500);
ok((await js('__truth()')).split('/').length === 1 + 8, '表: 入力 2 + メモリ 1 で 8 行', await js('__truth()'));
await click(await js('__btn("clock")'));
ok(await js('__memText()') === 'mem1', '保持: 許可ありで 1 を書ける', await js('__memText()'));
await click(await js('__nodeCenter("en")'));                     // 書き込み許可を 0 に
await click(await js('__nodeCenter("d")'));                      // データを 0 に
for (let i = 0; i < 3; i++) await click(await js('__btn("clock")'));
ok(await js('__memText()') === 'mem1', '保持: 許可なしなら 3 クロックでも保持', await js('__memText()'));
await click(await js('__nodeCenter("en")'));                     // 許可を 1 に戻す
await click(await js('__btn("clock")'));
ok(await js('__memText()') === 'mem0', '保持: 許可ありで 0 を書ける', await js('__memText()'));
// 入力を変えた分は列を増やさず今の列を書き換えるので、1 列 = 1 クロックが保たれる
ok(await js('__wave("d")') === '100000', '波形: d の履歴', await js('__wave("d")'));
ok(await js('__wave("en")') === '100011', '波形: en の履歴', await js('__wave("en")'));
ok(await js('__wave("mem")') === '011110', '波形: 許可なしの間は保持されている', await js('__wave("mem")'));
ok(await js('__wave("q")') === '011110', '波形: 出力も同じ', await js('__wave("q")'));

// ==================================================== 4 ビットバレルシフタ
await js('__preset("バレルシフタ")');
await sleep(700);
ok(await js('__nodeCount()') === 37, 'バレル: 37 部品 (定数 1 個を含む)', String(await js('__nodeCount()')));
ok(await js('__wireCount()') === 54, 'バレル: 54 配線', String(await js('__wireCount()')));
ok((await js('__msg()')).includes('コンパイル成功'), 'バレル: コンパイルできる', await js('__msg()'));
ok((await js('__truth()')).split('/').length === 1 + 64, 'バレル: 真理値表が 64 行',
  String((await js('__truth()')).split('/').length));
// 初期値 d0..d3 = 1011 (=13) を s0,s1 = 01 (=2) ビット左シフト → 0100 (=4)
ok(await js('__nowRow()') === 45, 'バレル: 今の入力は 45 行目', String(await js('__nowRow()')));
ok(await js('__rowCells(45)') === '1011010010', 'バレル: 13 を 2 ビット左シフトして 4', await js('__rowCells(45)'));
for (const [sig, want] of [['y0', 0], ['y1', 0], ['y2', 1], ['y3', 0]]) {
  ok(await js(`__nodeText("${sig}")`) === `${sig}${want}`, `バレル: ${sig} が ${want}`, await js(`__nodeText("${sig}")`));
}
await click(await js('__nodeCenter("s1")'));
for (const [sig, want] of [['y0', 1], ['y1', 0], ['y2', 1], ['y3', 1]]) {
  ok(await js(`__nodeText("${sig}")`) === `${sig}${want}`, `バレル: シフト 0 で ${sig} が ${want}`,
    await js(`__nodeText("${sig}")`));
}

// ==================================================== 組合せ回路の波形
await js('__preset("AND")');
await sleep(400);
ok(await js('__waveSigs()') === 'a,b,y0', '波形: 入力と出力の行が出る', await js('__waveSigs()'));
ok((await js('__waveInfo()')).includes('入力を変えた回数'), '波形: 1 列 = 入力の変更と表示', await js('__waveInfo()'));
await click(await js('__nodeCenter("b")'));
await click(await js('__nodeCenter("a")'));
ok(await js('__wave("a")') === '110', '波形: a の履歴', await js('__wave("a")'));
ok(await js('__wave("b")') === '011', '波形: b の履歴', await js('__wave("b")'));
ok(await js('__wave("y0")') === '010', '波形: AND の結果が並ぶ', await js('__wave("y0")'));

// ==================================================== 端子の名前を変える
await js('__preset("AND")');
await sleep(400);
await click(await js('__nodeCenter("y0")'));                  // 出力を選ぶ
await click(await js('__btn("renameBtn")'));
ok(await js('__renameBoxOpen()') === true, '名前: ボタンで入力欄が出る');
await type('result');
await key('Enter', 'Enter', 13);
ok(await js('__renameBoxOpen()') === false, '名前: Enter で閉じる');
ok((await js('__verilog()')).includes('assign result = n3;'), '名前: Verilog に反映される', await js('__verilog()'));
ok(await js('__nodeText("result")') === 'result0', '名前: 回路図の表示も変わる', await js('__nodeText("result")'));
ok((await js('__truth()')).startsWith('abresult/'), '名前: 真理値表の見出しも変わる', await js('__truth()'));

// 右クリックでも開く
await js('(() => { const g = __nodeAt("result"); const r = g.getBoundingClientRect();'
  + ' g.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: r.x + 5, clientY: r.y + 5 })); })()');
await sleep(150);
ok(await js('__renameBoxOpen()') === true, '名前: 右クリックでも開く');
await key('Escape', 'Escape', 27);
ok(await js('__renameBoxOpen()') === false, '名前: Escape で取り消せる');
ok(await js('__nodeText("result")') === 'result0', '名前: 取り消したら元のまま', await js('__nodeText("result")'));

// 予約語・重複は弾く / 空にすると自動名に戻る
await click(await js('__nodeCenter("result")'));
await key('F2', 'F2', 113);
ok(await js('__renameBoxOpen()') === true, '名前: F2 で開く');
await type('clk');
await key('Enter', 'Enter', 13);
ok((await js('__msg()')).includes('予約語'), '名前: 予約語を弾く', await js('__msg()'));
ok(await js('__nodeText("result")') === 'result0', '名前: 弾かれたら変わらない', await js('__nodeText("result")'));

await click(await js('__nodeCenter("result")'));
await key('F2', 'F2', 113);
await type('a');
await key('Enter', 'Enter', 13);
ok((await js('__msg()')).includes('他の端子'), '名前: 重複を弾く', await js('__msg()'));

await click(await js('__nodeCenter("result")'));
await key('F2', 'F2', 113);
await type(' ');
await key('Enter', 'Enter', 13);
ok(await js('__nodeText("y0")') === 'y00', '名前: 空にすると自動名に戻る', await js('__nodeText("y0")'));

await click(await js('__nodeCenter("AND")'));
await key('F2', 'F2', 113);
ok(await js('__renameBoxOpen()') === false, '名前: ゲートでは入力欄が出ない');
ok((await js('__msg()')).includes('名前を付けられません'), '名前: 理由を出す', await js('__msg()'));

// ==================================================== 定数
await click(await js('__button("定数")'));
await sleep(300);
ok(await js('__nodeCount()') === 5, '定数: 部品が増える', String(await js('__nodeCount()')));
ok((await js('__verilog()')).includes("= 1'b0;"), '定数: リテラルになる', await js('__verilog()'));
ok(!(await js('__verilog()')).includes('input  c'), '定数: 入力ポートにはならない', await js('__verilog()'));
ok((await js('__msg()')).includes('コンパイル成功'), '定数: 配線しなくても通る', await js('__msg()'));

const konst = await js('__center(document.querySelector("#gNodes .node.konst"))');
await click(konst);
ok((await js('__verilog()')).includes("= 1'b1;"), '定数: クリックで 1 になる', await js('__verilog()'));

await click(await js('__center(document.querySelector("#gNodes .node.konst .pin"))'));
await click(await js('__pinCenter("AND", 1)'));
ok(await js('__truth()') === 'aby0/000/101/010/111', '定数: 1 & a = a になる', await js('__truth()'));
ok(await js('__nodeText("y0")') === 'y01', '定数: 出力が点灯', await js('__nodeText("y0")'));

// ==================================================== 保存と読み込み
ok((await js('__options()')).startsWith('|s:AND'), 'リスト: サンプルが並ぶ', await js('__options()'));
const savedVerilog = await js('__verilog()');
const savedNodes = await js('__nodeCount()');
await js('__setName("わたしの回路")');
await click(await js('__btn("save")'));
ok((await js('__msg()')).includes('保存しました'), '保存: 完了が出る', await js('__msg()'));
ok((await js('__saved()')).includes('わたしの回路'), '保存: localStorage に入る', await js('__saved()'));
ok((await js('__options()')).includes('u:わたしの回路'), '保存: リストに出る', await js('__options()'));
ok(await js('__selected()') === 'u:わたしの回路', '保存: 保存したものが選択される', await js('__selected()'));

await js('__preset("半加算器")');
await sleep(400);
ok(await js('__nodeCount()') === 6, '読み込み: サンプルに移れる', String(await js('__nodeCount()')));
await js('(() => { const s = document.getElementById("presets"); s.value = "u:わたしの回路";'
  + ' s.dispatchEvent(new Event("change")); })()');
await sleep(500);
ok(await js('__nodeCount()') === savedNodes, '読み込み: 部品の数が戻る', String(await js('__nodeCount()')));
ok(await js('__verilog()') === savedVerilog, '読み込み: 同じ Verilog になる', await js('__verilog()'));
ok(await js('__cname()') === 'わたしの回路', '読み込み: 名前も入る', await js('__cname()'));

await click(await js('__btn("save")'));
ok((await js('__msg()')).includes('上書き'), '保存: 同じ名前は上書きになる', await js('__msg()'));

await js('__setName("")');
await click(await js('__btn("save")'));
ok((await js('__msg()')).includes('名前を入れて'), '保存: 名前が無いと断る', await js('__msg()'));

await js('__setName("わたしの回路")');
await click(await js('__btn("share")'));
ok((await js('__hash()')).startsWith('#c='), 'リンク: URL に回路が入る', await js('__hash()'));
const link = await js('__hash()');

await reopen(link);
ok(await js('__nodeCount()') === savedNodes, 'リンク: 開くと同じ回路', String(await js('__nodeCount()')));
ok(await js('__verilog()') === savedVerilog, 'リンク: Verilog も同じ', await js('__verilog()'));
ok(await js('__selected()') === '', 'リンク: リストは未選択', await js('__selected()'));

await reopen(`#c=${encodeURIComponent('%%%こわれた%%%')}`);
ok((await js('__msg()')).includes('共有リンクを読めませんでした'), 'リンク: 壊れていれば断る', await js('__msg()'));

await reopen();
ok(await js('__work()') !== null, '自動保存: 編集中の回路が localStorage にある');
ok(await js('__nodeCount()') === savedNodes, '自動保存: 開き直すと続きから', String(await js('__nodeCount()')));
ok(await js('__verilog()') === savedVerilog, '自動保存: 中身も同じ', await js('__verilog()'));

await click(await js('__nodeCenter("AND")'));
await key('Delete', 'Delete', 46);
await sleep(300);
const afterDelete = await js('__nodeCount()');
await reopen();
ok(await js('__nodeCount()') === afterDelete, '自動保存: 削除も追いかける', String(await js('__nodeCount()')));
ok((await js('__saved()')).includes('わたしの回路'), '保存: リロードしても残る', await js('__saved()'));

await js('(() => { const s = document.getElementById("presets"); s.value = "u:わたしの回路";'
  + ' s.dispatchEvent(new Event("change")); })()');
await sleep(500);
ok(await js('__nodeCount()') === savedNodes, '保存: リロード後も読み込める', String(await js('__nodeCount()')));

await click(await js('__btn("delSave")'));
ok(!(await js('__saved()')).includes('わたしの回路'), '削除: localStorage から消える', await js('__saved()'));
ok(!(await js('__options()')).includes('u:'), '削除: リストからも消える', await js('__options()'));
ok(await js('__nodeCount()') === savedNodes, '削除: 開いている回路はそのまま', String(await js('__nodeCount()')));
await click(await js('__btn("delSave")'));
ok((await js('__msg()')).includes('リストから保存した回路を選んで'), '削除: 対象が無ければ断る', await js('__msg()'));

// ==================================================== 選択
await js('__preset("半加算器")');
await sleep(500);
ok(await js('__selCount()') === 0, '選択: 最初は何も選ばれていない', String(await js('__selCount()')));
await click(await js('__nodeCenter("XOR")'));
ok(await js('__selCount()') === 1, '選択: クリックで 1 個', String(await js('__selCount()')));
await click(await js('__nodeCenter("AND")'), SHIFT);
ok(await js('__selCount()') === 2, '選択: Shift + クリックで足せる', String(await js('__selCount()')));
await click(await js('__nodeCenter("AND")'), SHIFT);
ok(await js('__selCount()') === 1, '選択: もう一度 Shift + クリックで外れる', String(await js('__selCount()')));

// 範囲選択 (背景をドラッグ)
await dragTo(await js('__corner(0.02, 0.02)'), await js('__corner(0.98, 0.98)'));
ok(await js('__selCount()') === 6, '範囲選択: 全部囲める', String(await js('__selCount()')));
await click(await js('__emptySpot()'));
ok(await js('__selCount()') === 0, '範囲選択: 背景クリックで解除', String(await js('__selCount()')));
await dragTo(await js('__corner(0.02, 0.02)'), await js('__corner(0.45, 0.5)'));
const partial = await js('__selCount()');
ok(partial > 0 && partial < 6, '範囲選択: 一部だけ選べる', String(partial));
await key('Escape', 'Escape', 27);
ok(await js('__selCount()') === 0, '選択: Escape で解除', String(await js('__selCount()')));
await ctrlKey('a');
ok(await js('__selCount()') === 6, '選択: Ctrl+A で全部', String(await js('__selCount()')));

// まとめて移動
await ctrlKey('a');
const xorPos = await js('__transform("XOR")');
const andPos = await js('__transform("AND")');
const from = await js('__nodeCenter("XOR")');
await dragTo(from, [from[0] + 60, from[1] + 40]);
ok(await js('__transform("XOR")') !== xorPos, 'まとめて移動: 掴んだ部品が動く');
ok(await js('__transform("AND")') !== andPos, 'まとめて移動: 選択した他の部品も動く');
ok(await js('__wireCount()') === 6, 'まとめて移動: 配線は保たれる', String(await js('__wireCount()')));

// ==================================================== 元に戻す / やり直し
await js('__preset("半加算器")');
await sleep(500);
ok(await js('__disabled("undo")') === true, 'Undo: 読み込み直後は戻せない');
ok(await js('__disabled("redo")') === true, 'Undo: やり直しも無い');

await click(await js('__nodeCenter("sum")'));
await key('Delete', 'Delete', 46);
ok(await js('__nodeCount()') === 5, 'Undo: 部品を消した', String(await js('__nodeCount()')));
ok(await js('__disabled("undo")') === false, 'Undo: 戻せるようになる');
await ctrlKey('z');
ok(await js('__nodeCount()') === 6, 'Undo: Ctrl+Z で戻る', String(await js('__nodeCount()')));
ok(await js('__wireCount()') === 6, 'Undo: 配線も戻る', String(await js('__wireCount()')));
ok(await js('__nodeText("sum")') === 'sum0', 'Undo: 端子の名前も戻る', await js('__nodeText("sum")'));
ok(await js('__disabled("redo")') === false, 'Undo: やり直せるようになる');
await ctrlKey('z', SHIFT);
ok(await js('__nodeCount()') === 5, 'Undo: Ctrl+Shift+Z でやり直し', String(await js('__nodeCount()')));
await click(await js('__btn("undo")'));
ok(await js('__nodeCount()') === 6, 'Undo: ボタンでも戻せる', String(await js('__nodeCount()')));

// 配線の切断も戻せる
await click(await js('__wireHit(0)'));
ok(await js('__wireCount()') === 5, 'Undo: 線を切った', String(await js('__wireCount()')));
await ctrlKey('z');
ok(await js('__wireCount()') === 6, 'Undo: 切断も戻せる', String(await js('__wireCount()')));

// 移動も戻せる
const movePos = await js('__transform("XOR")');
const grab = await js('__nodeCenter("XOR")');
await dragTo(grab, [grab[0] + 80, grab[1] + 60]);
ok(await js('__transform("XOR")') !== movePos, 'Undo: 部品を動かした');
await ctrlKey('z');
ok(await js('__transform("XOR")') === movePos, 'Undo: 移動も戻せる', await js('__transform("XOR")'));

// 全部消すも戻せる
await click(await js('__btn("clear")'));
ok(await js('__nodeCount()') === 0, 'Undo: 全部消した', String(await js('__nodeCount()')));
await ctrlKey('z');
ok(await js('__nodeCount()') === 6, 'Undo: 全部消すも戻せる', String(await js('__nodeCount()')));

// 入力の 0/1 は編集ではないので Undo の対象にしない
const undoDisabled = await js('__disabled("undo")');
await click(await js('__nodeCenter("a")'));
ok(await js('__disabled("undo")') === undoDisabled, 'Undo: 入力の反転は手順に積まない');

// 回路を読み込むと手順は捨てる
await js('__preset("AND")');
await sleep(400);
ok(await js('__disabled("undo")') === true, 'Undo: 回路を読み込むと戻せなくなる');

// ==================================================== コピーと貼り付け
await js('__preset("半加算器")');
await sleep(500);
const beforeCopy = await js('__nodeCount()');
await click(await js('__nodeCenter("XOR")'));
await ctrlKey('c');
ok((await js('__msg()')).includes('コピーしました'), 'コピー: 完了が出る', await js('__msg()'));
await ctrlKey('v');
await sleep(300);
ok(await js('__nodeCount()') === beforeCopy + 1, '貼り付け: 部品が 1 個増える', String(await js('__nodeCount()')));
ok(await js('__selCount()') === 1, '貼り付け: 貼ったものが選択される', String(await js('__selCount()')));
ok((await js('__types()')).split(',').filter((t) => t === 'XOR').length === 2,
  '貼り付け: 同じ種類の部品になる', await js('__types()'));
await ctrlKey('z');
ok(await js('__nodeCount()') === beforeCopy, '貼り付け: Undo で消える', String(await js('__nodeCount()')));

// 選択の中で閉じている配線ごとコピーする
await dragTo(await js('__corner(0.02, 0.02)'), await js('__corner(0.98, 0.98)'));
ok(await js('__selCount()') === 6, 'コピー: 全部選んだ', String(await js('__selCount()')));
await ctrlKey('c');
await ctrlKey('v');
await sleep(400);
ok(await js('__nodeCount()') === 12, '貼り付け: 6 部品が増える', String(await js('__nodeCount()')));
ok(await js('__wireCount()') === 12, '貼り付け: 配線もまとめて付いてくる', String(await js('__wireCount()')));
ok((await js('__msg()')).includes('コンパイル成功'), '貼り付け: そのままコンパイルできる', await js('__msg()'));
// 名前がぶつかるので _2 が付く
ok((await js('__verilog()')).includes('sum_2'), '貼り付け: 端子名は重複を避ける', await js('__verilog()'));
ok((await js('__verilog()')).includes('carry_2'), '貼り付け: carry も同じ', await js('__verilog()'));

// 貼り付けたものはまとめて動かせる (選択されたまま)
const pastedPos = await js('__transform("sum_2")');
const grab2 = await js('__nodeCenter("sum_2")');
await dragTo(grab2, [grab2[0] - 40, grab2[1] + 30]);
ok(await js('__transform("sum_2")') !== pastedPos, '貼り付け: すぐ動かせる');

// 切り取り
await js('__preset("半加算器")');
await sleep(500);
await click(await js('__nodeCenter("XOR")'));
await ctrlKey('x');
ok(await js('__nodeCount()') === 5, '切り取り: 部品が消える', String(await js('__nodeCount()')));
ok(await js('__wireCount()') === 3, '切り取り: 繋がっていた線も消える', String(await js('__wireCount()')));
await ctrlKey('v');
await sleep(300);
ok(await js('__nodeCount()') === 6, '切り取り: 貼り付けで戻せる', String(await js('__nodeCount()')));
await ctrlKey('z');
ok(await js('__nodeCount()') === 5, '切り取り: 貼り付けを Undo できる', String(await js('__nodeCount()')));
await ctrlKey('z');
ok(await js('__nodeCount()') === 6, '切り取り: 切り取り自体も Undo できる', String(await js('__nodeCount()')));

// 何も選んでいなければコピーしない
await click(await js('__emptySpot()'));
await ctrlKey('c');
ok((await js('__msg()')).includes('コピーする部品を選んで'), 'コピー: 選択が無ければ断る', await js('__msg()'));

// ボタンからも使える
await click(await js('__nodeCenter("AND")'));
await click(await js('__btn("copy")'));
await click(await js('__btn("pasteBtn")'));
await sleep(300);
ok(await js('__nodeCount()') === 7, '貼り付け: ボタンからも使える', String(await js('__nodeCount()')));

// ==================================================== 回路部品 (block)
// サンプルの「半加算器を部品にして 2 個」がそのまま全加算器になっているか
await js('__preset("全加算器")');
await sleep(700);
ok(await js('__blockCount()') === 2, 'サンプル: 部品が 2 個', String(await js('__blockCount()')));
ok((await js('__blockLabels()')) === '半加算器,半加算器', 'サンプル: 部品の名前が出る', await js('__blockLabels()'));
ok((await js('__msg()')).includes('コンパイル成功'), 'サンプル: そのままコンパイルできる', await js('__msg()'));
ok(await js('__truth()') === 'abcinsumcout/00000/10010/01010/11001/00110/10101/01101/11111',
  'サンプル: 全加算器の真理値表になる', await js('__truth()'));
ok(await js('__wireStartMismatch()') === '',
  '配線: 始点は駆動している出力端子から出る', await js('__wireStartMismatch()'));
// carry (端子 1) から出る線が 2 本あり、sum (端子 0) と同じ所から出ていないこと
ok((await js('__wireFroms()')).includes('10:1'), '配線: 2 番目の出力端子からの線がある', await js('__wireFroms()'));
await ctrlKey('a');
await ctrlKey('c');
await ctrlKey('v');
await sleep(600);
ok((await js('__wireFroms()')).split(',').filter((f) => f.endsWith(':1')).length === 4,
  '貼り付け: 2 番目の出力端子からの配線も端子番号を保つ', await js('__wireFroms()'));
ok(await js('__wireStartMismatch()') === '',
  '貼り付け: 貼った側も端子の位置から線が出る', await js('__wireStartMismatch()'));
await ctrlKey('z');
await sleep(400);

// 半加算器を保存して、それを部品として 2 個置き、全加算器を組んで真理値表で確かめる
await js('__preset("半加算器")');
await sleep(500);
await js('__setName("半加算器")');
await click(await js('__btn("save")'));
ok((await js('__pickOptions()')) === '半加算器', '部品: 保存すると部品リストに出る', await js('__pickOptions()'));

await click(await js('__btn("clear")'));
await sleep(300);
await js('__setPick("半加算器")');
await click(await js('__btn("placeBlock")'));
await sleep(400);
ok(await js('__blockCount()') === 1, '部品: 置ける', String(await js('__blockCount()')));
ok((await js('__blockLabels()')) === '半加算器', '部品: 元の回路名が出る', await js('__blockLabels()'));
ok((await js('__pinLabels()')) === 'a,b,sum,carry', '部品: 端子の名札が出る', await js('__pinLabels()'));
ok(await js('__blockPins()') === 4, '部品: 端子は 4 個', String(await js('__blockPins()')));
ok((await js('__msg()')).includes('入力 2 / 出力 2'), '部品: 端子の数を知らせる', await js('__msg()'));

// 入力 2 個と出力 2 個を繋ぐ
await click(await js('__button("入力")'));
await click(await js('__button("入力")'));
await click(await js('__button("出力")'));
await click(await js('__button("出力")'));
await sleep(300);
ok((await js('__msg()')).includes('未配線の部品が 3 個'),
  '部品: 未配線は画面の部品で数える (平坦化後の内部部品は数えない)', await js('__msg()'));

await click(await js('__pinCenter("a", -1)'));         // 入力 a の出力端子
await click(await js('__blockPin("in", 0, 2)'));       // 部品の入力端子 0
await click(await js('__pinCenter("b", -1)'));
await click(await js('__blockPin("in", 1, 2)'));
await click(await js('__blockPin("out", 0, 2)'));      // 部品の出力端子 0 (sum)
await click(await js('__pinCenter("y0", 0)'));
await click(await js('__blockPin("out", 1, 2)'));      // 出力端子 1 (carry)
await click(await js('__pinCenter("y1", 0)'));
await sleep(300);
ok(await js('__wireCount()') === 4, '部品: 端子ごとに配線できる', String(await js('__wireCount()')));
ok((await js('__msg()')).includes('コンパイル成功'), '部品: コンパイルできる', await js('__msg()'));
ok((await js('__verilog()')).includes('assign u'), '部品: 中継の assign が生える', await js('__verilog()'));
ok(await js('__truth()') === 'aby0y1/0000/1010/0110/1101',
  '部品: 半加算器の真理値表になる', await js('__truth()'));

// 部品の出力端子の値が画面に出る (a=1, b=1 → sum=0, carry=1)
await click(await js('__nodeCenter("a")'));
await click(await js('__nodeCenter("b")'));
await sleep(200);
ok(await js('__nodeText("y0")') === 'y00', '部品: sum の値が伝わる', await js('__nodeText("y0")'));
ok(await js('__nodeText("y1")') === 'y11', '部品: carry の値が伝わる', await js('__nodeText("y1")'));

// 波形にも部品の端子が出る
ok((await js('__waveSigs()')).includes('u'), '部品: 波形に端子の信号が出る', await js('__waveSigs()'));

// コピー・Undo も効く
await click(await js('__blockAt(0)'));
await ctrlKey('c');
await ctrlKey('v');
await sleep(400);
ok(await js('__blockCount()') === 2, '部品: コピーして増やせる', String(await js('__blockCount()')));
await ctrlKey('z');
ok(await js('__blockCount()') === 1, '部品: Undo で戻る', String(await js('__blockCount()')));

// 保存 → 開き直しても部品ごと残る (中身を埋め込んでいる)
await js('__setName("全加算器のもと")');
await click(await js('__btn("save")'));
const blockVerilog = await js('__verilog()');
await reopen();
ok(await js('__blockCount()') === 1, '部品: 開き直しても残る', String(await js('__blockCount()')));
ok(await js('__verilog()') === blockVerilog, '部品: 中身も同じ', await js('__verilog()'));

// 元の回路を書き換えて「部品を更新」すると中身が入れ替わる
await js('__preset("半加算器")');
await sleep(400);
await click(await js('__wireHit(5)'));                  // carry への配線を切る
await sleep(200);
await js('__setName("半加算器")');
await click(await js('__btn("save")'));                 // 壊れた版で上書き保存
await sleep(200);
await js('(() => { const s = document.getElementById("presets"); s.value = "u:全加算器のもと";'
  + ' s.dispatchEvent(new Event("change")); })()');
await sleep(500);
ok(await js('__verilog()') === blockVerilog, '部品: 元を直しても埋め込みは変わらない', await js('__verilog()'));
await click(await js('__btn("syncBlocks")'));
await sleep(500);
ok((await js('__msg()')).includes('更新しました'), '部品を更新: 完了が出る', await js('__msg()'));
ok(await js('__verilog()') !== blockVerilog, '部品を更新: 中身が入れ替わる');
ok(await js('__pinLabels()') === 'a,b,sum,carry', '部品を更新: 端子は残る', await js('__pinLabels()'));
await ctrlKey('z');
await sleep(400);
ok(await js('__verilog()') === blockVerilog, '部品を更新: Undo で戻せる', await js('__verilog()'));

// ==================================================== 幅 (バス)
await js('__preset("AND")');
await sleep(500);
ok(await js('__widthBox()') === null, '幅: 何も選んでいなければ欄は無効');
ok(!(await js('__verilog()')).includes('['), '幅: 既定は 1 ビット', await js('__verilog()'));

await click(await js('__nodeCenter("a")'));
ok(await js('__widthBox()') === '1', '幅: 入力を選ぶと欄が 1 になる', String(await js('__widthBox()')));
await js('__setWidth(4)');
await sleep(500);
ok((await js('__verilog()')).includes('input  [3:0] a'), '幅: 入力に幅が付く', await js('__verilog()'));
ok((await js('__msg()')).includes('幅が合わない'), '幅: 揃っていないと理由が出る', await js('__msg()'));

await click(await js('__nodeCenter("b")'));
await js('__setWidth(4)');
await sleep(500);
const busV = await js('__verilog()');
ok(busV.includes('input  [3:0] b'), '幅: もう一方にも付く', busV);
ok(busV.includes('output [3:0] n3'), '幅: ゲートに伝播する', busV);
ok(busV.includes('output [3:0] y0'), '幅: 出力に伝播する', busV);
ok(busV.includes('assign n3 = a & b;'), '幅: 式は 1 ビットのときと同じ', busV);
ok((await js('__msg()')).includes('コンパイル成功') && !(await js('__msg()')).includes('幅が合わない'),
  '幅: 揃えば警告が消える', await js('__msg()'));

// 多ビットの入力はクリックで値の箱が出る (1 ビットのときは反転だった)
await click(await js('__nodeCenter("a")'));
ok(await js('__valueBoxOpen()'), '幅: 多ビット入力をクリックすると値の箱が出る');
await js('__typeValue("A")');
await sleep(500);
ok(!(await js('__valueBoxOpen()')), '幅: Enter で箱が閉じる');
ok(await js('__nodeText("a")') === 'aA', '幅: 16 進で値が入る', await js('__nodeText("a")'));

await click(await js('__nodeCenter("b")'));
await js('__typeValue("C")');
await sleep(500);
ok(await js('__nodeText("b")') === 'bC', '幅: もう一方にも入る', await js('__nodeText("b")'));
ok(await js('__nodeText("y0")') === 'y08', '幅: A & C = 8 が出力に出る', await js('__nodeText("y0")'));

ok((await js('document.getElementById("truth").textContent')).includes('8 ビット'),
  '幅: 8 ビットは真理値表に収まらない旨を出す',
  await js('document.getElementById("truth").textContent'));

ok((await js('__busVals()')).includes('a=') && (await js('__busVals()')).includes('A'),
  '幅: 波形が多ビット行を値で描く', await js('__busVals()'));
ok(await js('__wave("a")') === null, '幅: 多ビット行は階段波形にならない');

// 幅を戻すと値も丸まる
await click(await js('__nodeCenter("a")'));
await js('__setWidth(1)');
await sleep(500);
ok((await js('__verilog()')).includes('input  a'), '幅: 1 に戻せる', await js('__verilog()'));
ok(await js('__nodeText("a")') === 'a0', '幅: 戻すと値が丸まる', await js('__nodeText("a")'));

// ------------------------------------------------------------------ 結果
console.log(`${passed} 件成功, ${failures.length} 件失敗`);
for (const f of failures) console.log(`  × ${f}`);
try { await send('Browser.close'); } catch { /* もう閉じている */ }
ws.close();
process.exit(failures.length ? 1 : 0);
