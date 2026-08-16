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
//   CDP_PORT=9444 node test/ui.js            … デバッグポート (塞がっていたら変える)
//
// ポートの取り合いは実際に起きる (WSL の wslrelay が 9333 を掴んでいた例がある)。
// 塞がっていると Chrome は DevTools を開けないまま起動してしまい、しかも
// **そのポートに居る別のプログラムが応答を返すので接続自体は成功する**。
// そのままだと原因の分からない「接続できない」になるので、下の CDP 接続で
// 何が起きたかを覚えておいて、落ちるときに Chrome の出力ごと見せる。

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// 共有リンクを作るためだけに使う (ブラウザに渡す回路をこちらで組み立てる)
import { encodeCircuit, expandCircuit } from '../src/schematic.js';

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
//
// **Chrome の stderr は捨てない。** 繋がらないときの原因はほとんどここに出ていて、
// 捨ててしまうと「接続できない」しか言えなくなる (ポートが塞がっていれば
// "Cannot start http server for devtools" が出る)。
const profile = mkdtempSync(join(tmpdir(), 'vwasm-ui-'));
const browser = spawn(chromePath, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  '--disable-extensions', '--window-size=1340,900',
  `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
  BASE,
], { stdio: ['ignore', 'ignore', 'pipe'] });

let browserLog = '';
let browserExit = null;
// 読み捨てずに必ず消費する (溜まるとパイプが詰まって Chrome が止まる)。
// 保持するのは頭だけ ― 起動時のエラーはそこに出る
browser.stderr.on('data', (d) => { if (browserLog.length < 64_000) browserLog += d; });
browser.on('exit', (code) => { browserExit = code; });

function teardown() {
  try { browser.kill(); } catch { /* もう死んでいる */ }
  try { server.kill(); } catch { /* もう死んでいる */ }
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* 掴まれている */ }
}
process.on('exit', teardown);

// ---------------------------------------------------------------- CDP 接続
//
// 繋がらない理由は 3 通りあって、どれなのかで直し方がまるで違う:
//
//   1. ポートに何も応答しない          … Chrome が起動していない / まだ起動中
//   2. 応答するが CDP ではない          … **そのポートを別のプログラムが使っている**
//   3. CDP だがページが無い             … ページの読み込みに失敗した
//
// 2 が曲者で、fetch は成功してしまうので「起動を待つ」側に倒れて 15 秒待たされた
// 挙げ句「接続できない」で終わる。**最後に何が起きたかを覚えておいて**、
// 落ちるときにそれを出す。
let target = null;
let why = `ポート ${CDP_PORT} に何も応答しない (Chrome が起動していない?)`;
for (let i = 0; i < 60 && !target; i++) {
  try {
    const body = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).text();
    let list = null;
    try { list = JSON.parse(body); } catch { /* CDP の応答ではない */ }
    if (!Array.isArray(list)) {
      why = `ポート ${CDP_PORT} で Chrome 以外の何かが応答している`
        + ` (返ってきたのは ${JSON.stringify(body.slice(0, 100))})`;
    } else if (!(target = list.find((t) => t.type === 'page' && t.url.includes('editor.html')))) {
      // 拡張機能や service worker まで並べると読めなくなるので、ページだけ数個
      const pages = list.filter((t) => t.type === 'page').map((t) => t.url);
      why = `Chrome には繋がったが ${BASE} のページが無い (開いているのは `
        + `${pages.slice(0, 3).join(' / ') || 'なし'}`
        + `${pages.length > 3 ? ` 他 ${pages.length - 3} 件` : ''})`;
    }
  } catch (e) {
    why = `ポート ${CDP_PORT} に何も応答しない (${e.cause?.message ?? e.message})`;
  }
  if (!target) await sleep(250);
}

if (!target) {
  console.log(`FAIL Chrome のページに接続できない: ${why}`);
  if (browserExit !== null) console.log(`     Chrome が終了しています (exit ${browserExit})`);
  // Chrome 自身が理由を書いていることが多いので、そのまま見せる
  const errs = browserLog.split('\n').filter((l) => /ERROR|FATAL/.test(l)).slice(0, 3);
  for (const line of errs) console.log(`     chrome: ${line.trim()}`);
  // 起動に成功したときも "DevTools listening on …" は出るので、
  // 「devtools」だけで見てはいけない。bind に失敗した印そのものを見る
  console.log(/Cannot start http server for devtools|bind\(\) returned an error/i.test(browserLog)
    ? `     → ポート ${CDP_PORT} が他のプログラムに使われています。`
      + 'CDP_PORT=9444 node test/ui.js のように空いている番号を指定してください'
    : '     → ポートを変えるなら CDP_PORT=9444 node test/ui.js、'
      + 'Chrome の場所を指定するなら CHROME=/path/to/chrome');
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
  // 端子のそばに出る幅の数字は飾りなので、部品の文字としては読まない
  window.__partText = (g) => [...g.querySelectorAll('text')]
    .filter((t) => !t.classList.contains('bw')).map((t) => t.textContent).join('').trim();
  // 端子ごとに出るので、部品 1 個ぶんをまとめて取る
  window.__bwOf = (prefix) => {
    const g = __nodeAt(prefix);
    if (!g) return null;
    const ws = [...g.querySelectorAll('text.bw')].map((t) => t.textContent);
    return ws.length ? ws.join(',') : null;
  };
  window.__nodeAt = (prefix) => [...document.querySelectorAll('#gNodes .node')]
    .find((g) => __partText(g).startsWith(prefix));
  window.__center = (elm) => { const r = elm.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; };
  window.__btn = (id) => __center(document.getElementById(id));
  // 幅の数字は箱の外に出ているので、中心は本体の矩形から取る
  window.__nodeCenter = (prefix) => __center(__nodeAt(prefix).querySelector('rect.body'));
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
    .map(__partText)[0] ?? null;
  window.__nodeText = (prefix) => { const g = __nodeAt(prefix); return g ? __partText(g) : null; };
  // 幅 (バス)
  window.__widthBox = () => {
    const w = document.getElementById('bitWidth');
    return w.disabled ? null : w.value;
  };
  // 返り値は「その場のメッセージ」。この後のコンパイル結果に上書きされるので先に取る
  window.__setWidth = (v) => {
    const w = document.getElementById('bitWidth');
    w.value = String(v);
    w.onchange();
    return document.getElementById('msg').textContent;
  };
  window.__valueBoxOpen = () => !!document.getElementById('renameBox');
  // 右クリックで出る下段の幅の欄
  window.__widthRow = () => document.getElementById('partWidthRow');
  window.__widthRowOpen = () => !!__widthRow();
  window.__widthRowLabel = () => __widthRow()?.querySelector('span').textContent ?? null;
  window.__widthRowValue = () => document.getElementById('partWidthBox')?.value ?? null;
  window.__focusId = () => document.activeElement?.id ?? '';
  /** 下段が部品の本体の真下・左端そろえで出ているか */
  window.__widthRowBelow = (prefix) => {
    const b = __nodeAt(prefix).querySelector('rect.body').getBoundingClientRect();
    const r = __widthRow().getBoundingClientRect();
    return r.top >= b.bottom && r.top - b.bottom < 12 && Math.abs(r.left - b.left) <= 1;
  };
  // 返り値は「その場のメッセージ」。この後のコンパイル結果に上書きされるので先に取る
  window.__typeWidth = (text) => {
    const b = document.getElementById('partWidthBox');
    b.value = text;
    b.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return document.getElementById('msg').textContent;
  };
  // 押せないものには ! を付けて返す ("- +!" なら + が押せない)
  window.__widthBtns = () => [...(__widthRow()?.querySelectorAll('button') ?? [])]
    .map((b) => b.textContent + (b.disabled ? '!' : '')).join(' ');
  /** 下段の - / + を押す (d は -1 か +1)。返り値はその場のメッセージ */
  window.__widthStep = (d) => {
    const b = [...__widthRow().querySelectorAll('button')].find((x) => Number(x.dataset.step) === d);
    b.click();
    return document.getElementById('msg').textContent;
  };
  window.__rightClick = (prefix) => {
    const g = __nodeAt(prefix);
    const r = g.getBoundingClientRect();
    g.dispatchEvent(new MouseEvent('contextmenu',
      { bubbles: true, clientX: r.x + 5, clientY: r.y + 5 }));
  };
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
    .map(__partText).sort().join(',');
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
  // ドラッグで選んだ区間。'from,to' か '' (選んでいない)
  window.__waveSel = () => {
    const r = document.querySelector('#waveSvg rect.selband');
    return r ? r.dataset.from + ',' + r.dataset.to : '';
  };
  // 区間の表で、値が変わった所に付く印
  window.__changed = () => [...document.querySelectorAll('#truth td.changed')].length;
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

// ---- 区間の選択 (ドラッグした範囲だけを表にする) ----
//
// 真理値表が「あり得る入力の全通し」なのに対し、区間の表は「実際に起きたこと」。
// トグルの回路なので q は 010101… で、区間を切り出すとそのまま列に並ぶはず。
ok(await js('__waveSel()') === '', '区間: 最初は選ばれていない');
ok((await js('__tableHead()')).includes('状態遷移表'), '区間: 選ぶ前は状態遷移表', await js('__tableHead()'));

await dragTo(await js('__waveColPoint(2)'), await js('__waveColPoint(5)'));
ok(await js('__waveSel()') === '2,5', '区間: ドラッグした範囲に帯が出る', await js('__waveSel()'));
ok((await js('__tableHead()')).includes('区間'), '区間: 表が区間の表に変わる', await js('__tableHead()'));
ok((await js('__truth()')).split('/').length === 1 + 4, '区間: 選んだ 4 列ぶんの行になる', await js('__truth()'));
// 見出しは「列 / (すきま) / 信号名…」、各行は「列番号 / (すきま) / 値…」。
// q は偶数列が 0 なので 2:00 3:11 4:00 5:11 と並ぶ
ok(await js('__truth()') === '列qout/200/311/400/511',
  '区間: 各列の値がそのまま並ぶ', await js('__truth()'));
// q も out も毎列変わるので、先頭の行を除く 3 行 × 2 信号に印が付く
ok(await js('__changed()') === 6, '区間: 前の列から変わった所に印が付く', String(await js('__changed()')));

// 右から左へドラッグしても同じ区間になる
await dragTo(await js('__waveColPoint(5)'), await js('__waveColPoint(2)'));
ok(await js('__waveSel()') === '2,5', '区間: 右から左へドラッグしても同じ', await js('__waveSel()'));

// 内部の配線を出すと区間の表の列も増える
await js('document.getElementById("waveGates").click()');
await sleep(200);
ok(await js('__truth()') === '列qoutn2/2001/3110/4001/5110',
  '区間: 出す信号を増やすと列も増える', await js('__truth()'));
await js('document.getElementById("waveGates").click()');
await sleep(200);

// 1 列だけ押すと区間が外れてカーソルに戻る (直前のカーソルは 3 列目にあるので別の列を押す)
await click(await js('__waveColPoint(5)'));
ok(await js('__waveSel()') === '', '区間: 1 列を押すと区間が外れてカーソルになる', await js('__waveSel()'));
ok(await js('__waveCursor()') === 5, '区間: 押した列にカーソルが移る', String(await js('__waveCursor()')));
ok((await js('__tableHead()')).includes('状態遷移表'), '区間: 外すと表も元に戻る', await js('__tableHead()'));

// カーソルが区間の中にあると、その行に印が付く
await click(await js('__waveColPoint(3)'));
await dragTo(await js('__waveColPoint(1)'), await js('__waveColPoint(4)'));
ok(await js('__waveCursor()') === 3, '区間: ドラッグしてもカーソルは動かない', String(await js('__waveCursor()')));
ok(await js('__nowRow()') === 2, '区間: 区間の中のカーソルの行に印が付く', String(await js('__nowRow()')));

await key('Escape', 'Escape', 27);
ok(await js('__waveSel()') === '', '区間: Escape で外れる', await js('__waveSel()'));
ok((await js('__tableHead()')).includes('状態遷移表'), '区間: Escape で表も戻る', await js('__tableHead()'));


await click(await js('__btn("waveClear")'));
ok(await js('__wave("q")') === '1', '波形: クリアすると今の値だけになる', await js('__wave("q")'));
ok(await js('__waveCursor()') === -1, 'カーソル: 波形をクリアすると外れる', String(await js('__waveCursor()')));
ok(await js('__waveSel()') === '', '区間: 波形をクリアすると外れる', await js('__waveSel()'));

const wh0 = await js('__waveH()');
const splitW = await js('__btn("splitW")');
await dragTo(splitW, [splitW[0], splitW[1] - 80]);
ok(await js('__waveH()') - wh0 > 60, '波形: 区切りをつまんで高くできる',
  `${wh0} → ${await js('__waveH()')}`);

await click(await js('__btn("zero")'));
ok(await js('__memText()') === 'q0', 'クリア: メモリが 0 に戻る', await js('__memText()'));
ok(await js('__cyc()') === 'cyc=0', 'クリア: カウンタも戻る', await js('__cyc()'));

// 区間の表はバスも扱う。波形と同じく 16 進で、4 ビットまとめて反転するので 0 → F → 0 …
await js('__preset("4 ビットメモリのトグル (バス)")');
await sleep(700);
await js('document.getElementById("nclk").value = 5');
await click(await js('__btn("clockN")'));
await sleep(400);
await dragTo(await js('__waveColPoint(1)'), await js('__waveColPoint(4)'));
ok(await js('__waveSel()') === '1,4', '区間: バスの回路でも選べる', await js('__waveSel()'));
ok(await js('__truth()') === '列q[3:0]out[3:0]/1FF/200/3FF/400',
  '区間: バスは 16 進で出る', await js('__truth()'));
ok(await js('__changed()') === 6, '区間: バスも変わった所に印が付く', String(await js('__changed()')));
await key('Escape', 'Escape', 27);

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
// 自動保存にも同じ回路が入っているので、部品の数だけ見るとリンクが読めていなくても通ってしまう。
// 「読めなかった」と言っていないことまで確かめる (実際にここで読めていない不具合を見落とした)
ok(!(await js('__msg()')).includes('読めませんでした'), 'リンク: 読めたと言っている', await js('__msg()'));
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

// ==================================================== 幅を混ぜる / 算術の部品
// サンプルを読んで、生成される Verilog と値が合っているかを見る
await js('__preset("1 ビット取り出して")');
await sleep(600);
const ripV = await js('__verilog()');
ok(ripV.includes('= a[0];'), '部品: ビット取り出しが部分選択になる', ripV);
ok(ripV.includes('= a[3];'), '部品: 添字を変えられる', ripV);
ok(/= \{\w+, \w+\};/.test(ripV), '部品: 連接が {hi, lo} になる', ripV);
ok(ripV.includes('output [1:0] sw'), '部品: 連接で幅が足し算になる', ripV);
ok((await js('__msg()')).includes('コンパイル成功'), '部品: コンパイルできる', await js('__msg()'));

// a = 6 (0110) → {a[0], a[3]} = {0, 0} = 00
ok(await js('__nodeText("sw")') === 'sw0', '部品: a=6 なら sw=0', await js('__nodeText("sw")'));
// a を 9 (1001) にすると {1, 1} = 11 = 3
await click(await js('__nodeCenter("a")'));
await js('__typeValue("9")');
await sleep(600);
ok(await js('__nodeText("sw")') === 'sw3', '部品: a=9 なら sw=3', await js('__nodeText("sw")'));

// ビット取り出しの添字はクリックで変えられる (10 進)
const bitNodes = await js(`[...document.querySelectorAll('#gNodes .node')]
  .filter(g => g.querySelector('text.idx')).map(g => g.querySelector('text.idx').textContent).join(',')`);
ok(bitNodes === '[0],[3]', '部品: 添字が箱に出る', bitNodes);
await js(`(() => {
  const g = [...document.querySelectorAll('#gNodes .node')].find(x => x.querySelector('text.idx')?.textContent === '[0]');
  const r = g.getBoundingClientRect();
  window.__bitPoint = [r.x + r.width / 2, r.y + r.height / 2];
  return 1;
})()`);
await click(await js('__bitPoint'));
ok(await js('__valueBoxOpen()'), '部品: ビット取り出しをクリックすると箱が出る');
await js('__typeValue("1")');
await sleep(600);
ok((await js('__verilog()')).includes('= a[1];'), '部品: 添字を 1 に変えられる', await js('__verilog()'));

// 幅を付けると範囲になる (部分選択)
await js('__preset("上下に割って")');
await sleep(600);
const sliceV = await js('__verilog()');
ok(sliceV.includes('= a[3:0];'), '部分選択: 下半分が a[3:0] になる', sliceV);
ok(sliceV.includes('= a[7:4];'), '部分選択: 上半分が a[7:4] になる', sliceV);
ok(sliceV.includes('output [7:0] sw'), '部分選択: 束ね直して 8 ビットに戻る', sliceV);
ok(await js('__nodeText("sw")') === 'sw5A', '部分選択: A5 の上下が入れ替わって 5A', await js('__nodeText("sw")'));

// 添字の箱には範囲が出る
const slices = await js(`[...document.querySelectorAll('#gNodes text.idx')].map(t=>t.textContent).join(',')`);
ok(slices === '[3:0],[7:4]', '部分選択: 箱に範囲が出る', slices);

// 「幅」の欄でビット取り出しの幅 (取り出すビット数) を変えられる
await js(`(() => {
  const g = [...document.querySelectorAll('#gNodes .node')].find(x => x.querySelector('text.idx')?.textContent === '[3:0]');
  const r = g.getBoundingClientRect();
  window.__slicePoint = [r.x + r.width / 2, r.y + 6];
  return 1;
})()`);
await click(await js('__slicePoint'));
ok(await js('__widthBox()') === '4', '部分選択: 幅の欄に取り出すビット数が出る', String(await js('__widthBox()')));
await js('__setWidth(2)');
await sleep(600);
ok((await js('__verilog()')).includes('= a[1:0];'), '部分選択: 幅を 2 にすると a[1:0]', await js('__verilog()'));

await js('__preset("加算器と比較")');
await sleep(600);
const addV = await js('__verilog()');
ok(addV.includes('= a + b;'), '部品: 加算が + になる', addV);
ok(addV.includes('= a < b;'), '部品: 小なりが < になる', addV);
ok(addV.includes('output [3:0] sum'), '部品: 加算の出力は入力と同じ幅', addV);
ok(addV.includes('output less') && !addV.includes('output [3:0] less'),
  '部品: 比較の出力は 1 ビット', addV);
ok(await js('__nodeText("sum")') === 'sumE', '部品: 9 + 5 = E', await js('__nodeText("sum")'));
ok(await js('__nodeText("less")') === 'less0', '部品: 9 < 5 は 0', await js('__nodeText("less")'));

// パレットに新しい部品のボタンが並んでいる
const btns = await js(`[...document.querySelectorAll('#palette button')].map(b => b.textContent).join(',')`);
for (const label of ['ビット', '連接', '加算', '減算', '乗算', '除算', '剰余', '一致', '小なり', '選択']) {
  ok(btns.includes(label), `部品: パレットに「${label}」がある`, btns);
}

// ---- パレットは左サイドに置く (上のツールバーが 3 段になるのを避けるため) ----
ok(await js(`(() => {
  const p = document.getElementById('palette').getBoundingClientRect();
  const c = document.getElementById('canvasWrap').getBoundingClientRect();
  return p.right <= c.left + 1 && p.width > 60;
})()`), 'パレット: 回路の左に縦に並ぶ');
// ツールバーは 1 段ずつ。折り返すと 1 段 45px が 80px 以上になる
const barHs = await js(`[...document.querySelectorAll('body > .bar')].filter(b => !b.hidden)
  .map(b => Math.round(b.getBoundingClientRect().height)).join(',')`);
ok(barHs.split(',').every((h) => Number(h) < 60), 'パレット: 上のツールバーが折り返さない', barHs);
// 入力から選択まで、スクロールせずに全部見えていること
ok(await js(`(() => { const p = document.getElementById('palette');
  return p.scrollHeight <= p.clientHeight + 1; })()`), 'パレット: 既定の大きさなら全部入る');
const partCount = await js(`document.querySelectorAll('#palette button.part').length`);
ok(partCount === 21, 'パレット: 置ける部品が 21 個そろっている', String(partCount));
// 見出しで区切る。書き忘れた部品が消えないよう「その他」に落ちる作りなので、
// その他が出ていないこと = 一覧に漏れが無いこと
const gl = await js(`[...document.querySelectorAll('#palette .glabel')].map(g => g.textContent).join(',')`);
ok(gl === '入出力,ゲート,メモリ,幅,算術', 'パレット: 見出しで区切られ、漏れが無い', gl);

// ==================================================== 連接の入力の本数
// 「幅」の欄は連接だけ意味が違って、入力端子の本数になる
await js('__preset("上下に割って")');
await sleep(600);
await js(`(() => {
  const g = [...document.querySelectorAll('#gNodes .node')].find(x => __partText(x) === '{ }');
  const r = g.getBoundingClientRect();
  window.__catPoint = [r.x + r.width / 2, r.y + r.height / 2];
  window.__catH = () => {
    const n = [...document.querySelectorAll('#gNodes .node')].find(x => __partText(x) === '{ }');
    return Math.round(n.querySelector('rect.body').getAttribute('height'));
  };
  return 1;
})()`);
const catH2 = await js('__catH()');
await click(await js('__catPoint'));
ok(await js('__widthBox()') === '2', '連接: 幅の欄に入力の本数 (2) が出る', String(await js('__widthBox()')));

// 3 本にすると端子が 1 本増える。増えた端子は未配線なので回路からは落ちる
const catMsg = await js('__setWidth(3)');
ok(catMsg.includes('3 入力'), '連接: 本数を変えたと言ってくる', catMsg);
await sleep(600);
ok(await js('__catH()') > catH2, '連接: 端子が増えると箱が伸びる',
  `${await js('__catH()')} <= ${catH2}`);
ok(!(await js('__verilog()')).includes('{'), '連接: 未配線の端子があると回路に出ない', await js('__verilog()'));

// 2 本に戻すと元どおり
await click(await js('__catPoint'));
await js('__setWidth(2)');
await sleep(600);
ok((await js('__verilog()')).includes('output [7:0] sw'), '連接: 2 本に戻すと元どおり',
  await js('__verilog()'));
ok(await js('__catH()') === catH2, '連接: 箱の高さも戻る', String(await js('__catH()')));

// 1 は連接にならないので 2 に上がる
await click(await js('__catPoint'));
await js('__setWidth(1)');
await sleep(600);
ok(await js('__widthBox()') === '2', '連接: 本数 1 は 2 に上がる', String(await js('__widthBox()')));

// ==================================================== 端子に出す幅
// 1 ビットでないバスは、それを運ぶ端子のそばに数字だけで出る
await js('__preset("上下に割って")');
await sleep(600);
ok(await js('__bwOf("a")') === '8', '幅: 8 ビットの入力の端子に 8 が出る', String(await js('__bwOf("a")')));
ok(await js('__bwOf("sw")') === '8', '幅: 出力ポートにも伝わった幅が出る', String(await js('__bwOf("sw")')));
const slicebw = await js(`[...document.querySelectorAll('#gNodes .node')]
  .filter(g => g.querySelector('text.idx')).map(g => g.querySelector('text.bw')?.textContent).join(',')`);
ok(slicebw === '4,4', '幅: 部分選択は取り出したビット数を出す', slicebw);
// 単位を付けずに数字だけ出す (密度を上げないため)
const bwTexts = await js(`[...document.querySelectorAll('#gNodes text.bw')].map(t=>t.textContent).join(',')`);
ok(/^[\d,]+$/.test(bwTexts), '幅: 数字だけで単位は付かない', bwTexts);

// 出力を持つ部品は右の端子、出力ポートは左の端子 (幅が入ってくる側) に付く
const bwSide = await js(`(() => {
  const at = (p) => { const g = __nodeAt(p); const b = g.querySelector('rect.body');
    return Number(g.querySelector('text.bw').getAttribute('x')) > Number(b.getAttribute('width')) / 2; };
  return [at('a'), at('sw')].join(',');
})()`);
ok(bwSide === 'true,false', '幅: 入力は右の端子・出力ポートは左の端子に付く', bwSide);

// 箱に重ねる入力欄が幅の数字に引っ張られていないか (本体の矩形に合っているか)
await click(await js('__nodeCenter("a")'));
ok(await js('__valueBoxOpen()'), '幅: 8 ビット入力をクリックすると値の箱が出る');
const boxFit = await js(`(() => {
  const r = document.getElementById('renameBox').getBoundingClientRect();
  const b = __nodeAt('a').querySelector('rect.body').getBoundingClientRect();
  return Math.round(Math.abs(r.x - b.x)) <= 1 && Math.round(Math.abs(r.height - b.height)) <= 1;
})()`);
ok(boxFit, '幅: 値の箱は部品の本体にぴったり重なる');
await key('Escape', 'Escape', 27);

// 1 ビットだけの回路には 1 個も出ない
await js('__preset("AND")');
await sleep(600);
const bwCount = await js(`document.querySelectorAll('#gNodes text.bw').length`);
ok(bwCount === 0, '幅: 1 ビットの回路には出ない', String(bwCount));

// 幅を変えると数字も変わる
await click(await js('__nodeCenter("a")'));
await js('__setWidth(4)');
await sleep(600);
ok(await js('__bwOf("a")') === '4', '幅: 幅を変えると数字も変わる', String(await js('__bwOf("a")')));
await js('__setWidth(1)');
await sleep(600);
ok(await js('__bwOf("a")') === null, '幅: 1 ビットに戻すと消える', String(await js('__bwOf("a")')));

// 回路部品は端子ごとに幅が違うので、端子ごとに出す。中身は
// 「4 ビット入力 → そのまま y4 (4 ビット)」と「→ 1 ビット取り出して y1」の 2 出力
const busBlockLink = encodeCircuit(expandCircuit({
  nodes: [
    [1, 'in', 40, 120, 5, 'x', null, 4],
    [2, 'block', 280, 100, 0, null, {
      ref: '幅つき部品',
      def: {
        nodes: [[1, 'in', 40, 40, 0, 'a', null, 4], [2, 'out', 320, 20, 0, 'y4'],
          [3, 'bit', 180, 150, 0], [4, 'out', 320, 150, 0, 'y1']],
        wires: [[1, 0, 2, 0], [1, 0, 3, 0], [3, 0, 4, 0]],
      },
    }],
    [3, 'out', 560, 60, 0, 'z4'], [4, 'out', 560, 200, 0, 'z1'],
  ],
  wires: [[1, 0, 2, 0], [2, 0, 3, 0], [2, 1, 4, 0]],
}));
await reopen(`#c=${busBlockLink}`);
await sleep(600);
ok((await js('__verilog()')).includes('output [3:0] z4'), '幅: 幅つきの部品を開けた', await js('__verilog()'));
ok(await js('__bwOf("幅つき部品")') === '4', '幅: 回路部品は 4 ビットの端子だけに数字が出る',
  String(await js('__bwOf("幅つき部品")')));
ok(await js('__bwOf("z4")') === '4', '幅: 部品の 4 ビット出力を受けた出力ポートに 4 が出る',
  String(await js('__bwOf("z4")')));
ok(await js('__bwOf("z1")') === null, '幅: 1 ビット出力を受けた側には出ない',
  String(await js('__bwOf("z1")')));

// ==================================================== 右クリックの下段で幅を打つ
// ツールバーの「幅」は部品から離れていて打ちにくいので、部品のすぐ下にも出す
await js('__preset("上下に割って")');
await sleep(600);

// 名前も幅もある部品 (入力) は 2 段になる
await js('__rightClick("a")');
await sleep(200);
ok(await js('__renameBoxOpen()') === true, '下段: 名前の欄が上段に出る');
ok(await js('__widthRowOpen()') === true, '下段: 幅の欄が一緒に出る');
ok(await js('__widthRowValue()') === '8', '下段: いまの幅が入っている', String(await js('__widthRowValue()')));
ok(await js('__widthRowLabel()') === '幅', '下段: 見出しは「幅」', String(await js('__widthRowLabel()')));
ok(await js('__widthRowBelow("a")'), '下段: 部品の本体の真下に出る');
// 上段は部品の本体にぴったり重なる (置く前に focus するとスクロールしてずれていた)
const fit = await js(`(() => {
  const r = document.getElementById('renameBox').getBoundingClientRect();
  const b = __nodeAt('a').querySelector('rect.body').getBoundingClientRect();
  return [Math.round(r.x - b.x), Math.round(r.y - b.y), Math.round(r.height - b.height)].join(',');
})()`);
ok(fit === '0,0,0', '下段: 上段は部品の本体にぴったり重なる', fit);
ok(await js('__focusId()') === 'renameBox', '下段: 焦点は上段 (名前) にある', String(await js('__focusId()')));

// Escape で 2 段まとめて消える
await key('Escape', 'Escape', 27);
ok(await js('__renameBoxOpen()') === false, '下段: Escape で上段が消える');
ok(await js('__widthRowOpen()') === false, '下段: Escape で下段も消える');

// 下段に打ち込むと幅が変わる。ツールバーを触らずに済む
await js('__rightClick("a")');
await sleep(200);
const wMsg = await js('__typeWidth("4")');
ok(wMsg.includes('4 ビット') && wMsg.includes('a'), '下段: 何をしたか言う', wMsg);
await sleep(600);
ok(await js('__bwOf("a")') === '4', '下段: 打ち込んだ幅になる', String(await js('__bwOf("a")')));
ok(await js('__widthRowOpen()') === false, '下段: Enter で閉じる');
ok((await js('__verilog()')).includes('input  [3:0] a'), '下段: Verilog も変わる', await js('__verilog()'));
await js('__rightClick("a")');
await sleep(200);
await js('__typeWidth("8")');            // 元に戻す
await sleep(600);

// 上段から下段へマウスで移るとき、上段が焦点を外して確定するのに下段は生き残ること。
// (下段が自分で焦点を取る作りだと、上段に奪われた瞬間に blur → 確定 → 消滅していた)
await js('__rightClick("a")');
await sleep(200);
await click(await js('__center(document.getElementById("partWidthBox"))'));
await sleep(150);
ok(await js('__renameBoxOpen()') === false, '下段: 下段を触ると上段は確定して閉じる');
ok(await js('__widthRowOpen()') === true, '下段: 下段は残る');
ok(await js('__focusId()') === 'partWidthBox', '下段: 焦点が下段に移る', String(await js('__focusId()')));
ok((await js('__nodeText("a")')).startsWith('a'), '下段: 名前は変わっていない', await js('__nodeText("a")'));
await key('Escape', 'Escape', 27);

// 名前が付けられない部品 (ビット取り出し) は下段だけ出て、そこに焦点が来る
await js(`(() => {
  const g = [...document.querySelectorAll('#gNodes .node')].find(x => x.querySelector('text.idx'));
  const r = g.getBoundingClientRect();
  g.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.x + 5, clientY: r.y + 5 }));
})()`);
await sleep(200);
ok(await js('__renameBoxOpen()') === false, '下段: 名前を付けられない部品では上段が出ない');
ok(await js('__widthRowOpen()') === true, '下段: 幅の欄だけ出る');
ok(await js('__focusId()') === 'partWidthBox', '下段: 焦点は下段に来る', String(await js('__focusId()')));
await js('__typeWidth("2")');
await sleep(600);
ok((await js('__verilog()')).includes('a[1:0]'), '下段: 取り出すビット数も下段で変えられる', await js('__verilog()'));

// 連接は「幅」ではなく「本数」
await js('__rightClick("{ }")');
await sleep(200);
ok(await js('__widthRowLabel()') === '本数', '下段: 連接の見出しは「本数」', String(await js('__widthRowLabel()')));
const pMsg = await js('__typeWidth("3")');
ok(pMsg.includes('3 入力'), '下段: 連接は入力の本数として扱う', pMsg);
await sleep(600);

// ---- 欄の外を押したら閉じる (焦点を持っていない下段が残る不具合があった) ----
await js('__preset("上下に割って")');
await sleep(600);
await js('__rightClick("a")');
await sleep(200);
ok(await js('__widthRowOpen()') === true, '外を押す: まず 2 段出ている');
await click(await js('__emptySpot()'));
await sleep(250);
ok(await js('__renameBoxOpen()') === false, '外を押す: 上段が消える');
ok(await js('__widthRowOpen()') === false, '外を押す: 焦点の無い下段も消える');

// 別の回路に切り替えても残らない
await js('__rightClick("a")');
await sleep(200);
await js('__preset("AND")');
await sleep(600);
ok(await js('__widthRowOpen()') === false, '外を押す: 回路を切り替えたら消える');
ok(await js('__renameBoxOpen()') === false, '外を押す: 上段も消える');

// ---- 左の - と右の + ----
await js('__preset("上下に割って")');
await sleep(600);
await js('__rightClick("a")');
await sleep(200);
ok(await js('__widthBtns()') === '- +', '増減: 左が - 、右が + の順に並ぶ', String(await js('__widthBtns()')));
const upMsg = await js('__widthStep(1)');
ok(upMsg.includes('9 ビット'), '増減: + で 1 増える', upMsg);
await sleep(600);
ok(await js('__widthRowValue()') === '9', '増減: 欄の数字も追いつく', String(await js('__widthRowValue()')));
ok(await js('__bwOf("a")') === '9', '増減: 回路にも効く', String(await js('__bwOf("a")')));
ok(await js('__widthRowOpen()') === true, '増減: 押しても欄は開いたまま');
ok(await js('__widthRowBelow("a")'), '増減: 部品に付いたまま');
await js('__widthStep(-1)');
await sleep(600);
ok(await js('__bwOf("a")') === '8', '増減: - で 1 減る', String(await js('__bwOf("a")')));

// 上限・下限では押せなくなる
await js('__typeWidth("32")');
await sleep(600);
await js('__rightClick("a")');
await sleep(200);
ok(await js('__widthBtns()') === '- +!', '増減: 32 では + が押せない', String(await js('__widthBtns()')));
await js('__typeWidth("1")');
await sleep(600);
await js('__rightClick("a")');
await sleep(200);
ok(await js('__widthBtns()') === '-! +', '増減: 1 では - が押せない', String(await js('__widthBtns()')));
await js('__typeWidth("8")');
await sleep(600);

// 連接は下限が 2 (1 本の連接は無い)
await js('__rightClick("{ }")');
await sleep(200);
await js('__widthStep(-1)');
await sleep(600);
await js('__widthStep(-1)');
await sleep(600);
ok(await js('__widthRowValue()') === '2', '増減: 連接は 2 より下がらない', String(await js('__widthRowValue()')));

// Escape は打ちかけを捨てる (焦点を外すと確定してしまうので印を先に立てている)
await js('__rightClick("a")');
await sleep(200);
await js(`document.getElementById('partWidthBox').value = '16'`);
await key('Escape', 'Escape', 27);
await sleep(400);
ok(await js('__bwOf("a")') === '8', 'Escape: 打ちかけの幅は捨てる', String(await js('__bwOf("a")')));

// 幅も名前も無い部品 (ゲート) は理由を出して何も出さない
await js('__preset("AND")');
await sleep(600);
await js('__rightClick("AND")');
await sleep(200);
ok(await js('__renameBoxOpen()') === false, '下段: ゲートでは上段が出ない');
ok(await js('__widthRowOpen()') === false, '下段: ゲートでは下段も出ない');
ok((await js('__msg()')).includes('繋いだ先から決まります'), '下段: ゲートには理由を出す', await js('__msg()'));

// ==================================================== 「開発中」トグル
// ON (既定) は観測用にゲートの出力も output にする。OFF は「出力」部品だけ
await js('__preset("4 ビット加算器と比較")');
await sleep(700);
const probe = () => js(`document.getElementById('probeAll').getAttribute('aria-pressed')`);
const decls = () => js(`__verilog().split('\\n').filter(l => /^\\s+(wire|reg)\\s/.test(l)).join('/')`);
const ports = () => js(`__verilog().split('\\n').filter(l => /^\\s+output/.test(l)).join('/')`);

ok(await probe() === 'true', '開発中: 既定は押されている', String(await probe()));
ok((await ports()).includes('n3'), '開発中: ON ならゲートの出力も output', await ports());
ok(await decls() === '', '開発中: ON なら内部宣言は出ない', await decls());
ok(await js('__nodeText("sum")') === 'sumE', '開発中: 9 + 5 = E', await js('__nodeText("sum")'));

// OFF にすると「出力」部品だけがポートになり、残りは wire になる
await click(await js('__btn("probeAll")'));
await sleep(700);
ok(await probe() === 'false', '開発中: 押すと解除される', String(await probe()));
ok(!(await ports()).includes('n3'), '開発中: OFF ならゲートは output に出ない', await ports());
ok((await ports()).includes('sum') && (await ports()).includes('less'),
  '開発中: OFF でも「出力」部品はポートに残る', await ports());
ok((await decls()).includes('wire [3:0] n3'), '開発中: OFF ならゲートは wire で宣言される', await decls());
// 出力の値は引き続き読める。組合せ配線は読めなくなる (= 値が不明なので破線になる)
ok(await js('__nodeText("sum")') === 'sumE', '開発中: OFF でも出力の値は出る', await js('__nodeText("sum")'));
const deadWires = () => js(`[...document.querySelectorAll('#gWires .wire')]
  .filter(p => p.classList.contains('dead')).length`);
ok(await deadWires() === 2, '開発中: OFF ではゲートが駆動する線が不明 (破線) になる',
  String(await deadWires()));
ok(await js('__disabled("waveGates")'), '開発中: OFF では「内部の配線も出す」を止める');
// 観測用のスロットが減るので WASM も小さくなる
const smaller = await js(`document.getElementById('stats').textContent`);
ok(/wasm=477B/.test(smaller), '開発中: OFF は観測用のスロットが減って小さくなる', smaller);

// メモリは状態なのでスロットを持つ = OFF でも値が見える
await js('__preset("クロックで反転する 1 ビットメモリ")');
await sleep(700);
ok((await decls()).includes('reg  q'), '開発中: OFF ならメモリは reg で宣言される', await decls());
ok(await js('__memText()') === 'q0', '開発中: OFF でもメモリの値は読める', String(await js('__memText()')));
await click(await js('__btn("clock")'));
await sleep(400);
ok(await js('__memText()') === 'q1', '開発中: OFF でもクロックが打てる', String(await js('__memText()')));

// 「出力」部品が無い回路は外に出る信号が無くなるので、その旨を出す
await js(`(() => { __setName(''); document.getElementById('clear').click(); })()`);
await sleep(400);
await click(await js('__button("入力")'));
await click(await js('__button("NOT")'));
await sleep(500);
ok((await js('__msg()')).includes('外に出る信号がありません'),
  '開発中: OFF で出力部品が無いと理由を出す', await js('__msg()'));

// ON に戻すと元どおり
await click(await js('__btn("probeAll")'));
await sleep(700);
ok(await probe() === 'true', '開発中: もう一度押すと戻る', String(await probe()));
ok(!(await js('__disabled("waveGates")')), '開発中: ON に戻すと波形の欄も戻る');

// ------------------------------------------------------------------ 結果
console.log(`${passed} 件成功, ${failures.length} 件失敗`);
for (const f of failures) console.log(`  × ${f}`);
try { await send('Browser.close'); } catch { /* もう閉じている */ }
ws.close();
process.exit(failures.length ? 1 : 0);
