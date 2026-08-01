// 回路グラフ (GUI エディタの中間表現) → Verilog ソース。
//
// README の「フロントエンドを差し替えればバックエンドはそのまま使える」を
// 実際にやる部分。GUI で置いた部品と配線をそのまま Verilog に落として、
// あとは既存の compile() に渡すだけ。ネットリスト IR を直接組む方法もあるが、
// Verilog を経由すると「エディタで描いた回路のソース」を人が読めて得。
//
// グラフの形:
//   nodes: [{ id: 1, type: 'and', x, y }]      … id は正の整数、type は PARTS のキー
//   wires: [{ from: {node, port}, to: {node, port} }]
// port は 0 始まりの端子番号。出力端子は今は 1 個だけなので from.port は常に 0。

/** 部品の仕様。GUI の描画とネットリスト生成の両方がここを見る */
export const PARTS = {
  in:    { label: '入力',   glyph: 'IN',    btn: '入力', ins: 0, outs: 1, named: true },
  out:   { label: '出力',   glyph: 'OUT',   btn: '出力', ins: 1, outs: 0, named: true },
  // 0 か 1 に固定された値。ポートではなくリテラル (1'b0 / 1'b1) になる
  const: { label: '定数',   glyph: 'CONST', btn: '定数', ins: 0, outs: 1, konst: true },
  not:   { label: 'NOT',    glyph: 'NOT',  ins: 1, outs: 1 },
  and:   { label: 'AND',    glyph: 'AND',  ins: 2, outs: 1 },
  or:    { label: 'OR',     glyph: 'OR',   ins: 2, outs: 1 },
  xor:   { label: 'XOR',    glyph: 'XOR',  ins: 2, outs: 1 },
  nand:  { label: 'NAND',   glyph: 'NAND', ins: 2, outs: 1 },
  nor:   { label: 'NOR',    glyph: 'NOR',  ins: 2, outs: 1 },
  xnor:  { label: 'XNOR',   glyph: 'XNOR', ins: 2, outs: 1 },
  // 1 ビットのメモリ (D フリップフロップ)。クロックは 1 本を全体で共有するので端子には出さない
  dff:   { label: '1 ビットメモリ', glyph: 'DFF', ins: 1, outs: 1, reg: true, named: true },
};

/** メモリを 1 個でも使うときに生える暗黙のクロック入力 */
export const CLOCK = 'clk';

const IDENT = /^[A-Za-z_][A-Za-z0-9_$]*$/;
const RESERVED = new Set([
  CLOCK, 'module', 'endmodule', 'input', 'output', 'inout', 'wire', 'reg', 'assign',
  'always', 'posedge', 'negedge', 'begin', 'end', 'if', 'else', 'case', 'endcase',
  'and', 'or', 'not', 'nand', 'nor', 'xor', 'xnor', 'buf',
]);

/**
 * 端子に付けた名前が使えるか調べる。
 * @param {string} name
 * @param {Set<string>} taken 他のノードが既に使っている名前
 * @returns {string|null} 使えるなら null、駄目なら理由
 */
export function checkName(name, taken = new Set()) {
  if (!IDENT.test(name)) return `'${name}' は識別子として使えません (英字か _ で始めてください)`;
  if (RESERVED.has(name)) return `'${name}' は Verilog の予約語なので使えません`;
  if (taken.has(name)) return `'${name}' は他の端子が使っています`;
  return null;
}

/**
 * GUI エディタのサンプル回路。examples/*.v の回路グラフ版。
 * 圧縮形式: nodes は [id, type, x, y, 入力の初期値, 端子名], wires は [出力ノード, 端子, 入力ノード, 端子]。
 * 端子名は省略すると自動名 (入力 a,b,… / 出力 y0,y1,… / それ以外 n<id>) になる。
 */
export const SAMPLE_CIRCUITS = {
  'AND ゲート': {
    nodes: [[1, 'in', 40, 90, 1], [2, 'in', 40, 200, 0], [3, 'and', 300, 145], [4, 'out', 560, 145]],
    wires: [[1, 0, 3, 0], [2, 0, 3, 1], [3, 0, 4, 0]],
    expect: { y0: [0, 0, 0, 1] },
  },
  '半加算器 (sum / carry)': {
    nodes: [
      [1, 'in', 40, 90, 1], [2, 'in', 40, 260, 1],
      [3, 'xor', 300, 90], [4, 'and', 300, 260],
      [5, 'out', 560, 90, 0, 'sum'], [6, 'out', 560, 260, 0, 'carry'],
    ],
    wires: [[1, 0, 3, 0], [2, 0, 3, 1], [1, 0, 4, 0], [2, 0, 4, 1], [3, 0, 5, 0], [4, 0, 6, 0]],
    expect: { sum: [0, 1, 1, 0], carry: [0, 0, 0, 1] },
  },
  'NAND 4 個で XOR': {
    nodes: [
      [1, 'in', 30, 100, 1], [2, 'in', 30, 300, 0],
      [3, 'nand', 210, 200], [4, 'nand', 400, 90], [5, 'nand', 400, 310],
      [6, 'nand', 590, 200], [7, 'out', 780, 200, 0, 'y'],
    ],
    wires: [
      [1, 0, 3, 0], [2, 0, 3, 1],
      [1, 0, 4, 0], [3, 0, 4, 1],
      [3, 0, 5, 0], [2, 0, 5, 1],
      [4, 0, 6, 0], [5, 0, 6, 1],
      [6, 0, 7, 0],
    ],
    expect: { y: [0, 1, 1, 0] },
  },
  '多数決 (3 入力のうち 2 つ以上が 1)': {
    nodes: [
      [1, 'in', 30, 60, 1], [2, 'in', 30, 200, 1], [3, 'in', 30, 340, 0],
      [4, 'and', 220, 80], [5, 'and', 220, 230], [6, 'and', 220, 370],
      [7, 'or', 430, 150], [8, 'or', 620, 240], [9, 'out', 800, 240, 0, 'y'],
    ],
    wires: [
      [1, 0, 4, 0], [2, 0, 4, 1],
      [2, 0, 5, 0], [3, 0, 5, 1],
      [1, 0, 6, 0], [3, 0, 6, 1],
      [4, 0, 7, 0], [5, 0, 7, 1],
      [7, 0, 8, 0], [6, 0, 8, 1],
      [8, 0, 9, 0],
    ],
    expect: { y: [0, 0, 0, 1, 0, 1, 1, 1] },
  },
  'クロックで反転する 1 ビットメモリ': {
    nodes: [
      [1, 'dff', 330, 180, 0, 'q'], [2, 'not', 530, 180], [3, 'out', 700, 180, 0, 'out'],
    ],
    // Q を反転して自分の D に戻す。1 クロックごとに 0 → 1 → 0 …
    wires: [[1, 0, 2, 0], [2, 0, 1, 0], [1, 0, 3, 0]],
    seq: [
      { expect: { out: 0 } },
      { clock: 1, expect: { out: 1 } },
      { clock: 1, expect: { out: 0 } },
      { clock: 1, expect: { out: 1 } },
      { clock: 7, expect: { out: 0 } },
    ],
  },
  '書き込みイネーブル付き 1 ビットメモリ': {
    nodes: [
      [1, 'in', 20, 60, 1, 'd'], [2, 'in', 20, 300, 1, 'en'],
      [3, 'not', 170, 380],
      [4, 'and', 320, 60], [5, 'and', 320, 300],     // d & en  /  Q & ~en
      [6, 'or', 470, 170], [7, 'dff', 620, 170, 0, 'mem'], [8, 'out', 790, 170, 0, 'q'],
    ],
    // en=1 なら d を取り込み、en=0 なら今の値を保持する (2:1 マルチプレクサ)
    wires: [
      [2, 0, 3, 0],
      [1, 0, 4, 0], [2, 0, 4, 1],
      [7, 0, 5, 0], [3, 0, 5, 1],
      [4, 0, 6, 0], [5, 0, 6, 1],
      [6, 0, 7, 0], [7, 0, 8, 0],
    ],
    seq: [
      { set: { d: 1, en: 1 }, expect: { q: 0 } },               // クロック前は 0
      { clock: 1, expect: { q: 1 } },                           // 許可ありで 1 を書く
      { set: { d: 0, en: 0 }, clock: 3, expect: { q: 1 } },     // 許可なしなので保持
      { set: { en: 1 }, clock: 1, expect: { q: 0 } },           // 許可ありで 0 を書く
      { set: { d: 1, en: 0 }, clock: 5, expect: { q: 0 } },     // また保持
    ],
  },
  '組合せループ (エラーになる例)': {
    nodes: [[1, 'in', 60, 200, 1], [2, 'and', 300, 200], [3, 'not', 520, 200]],
    wires: [[1, 0, 2, 0], [3, 0, 2, 1], [2, 0, 3, 0]],
    loop: true,
  },
  '4 ビットバレルシフタ (論理左シフト)': barrelShifter4(),
};

/**
 * 4 ビットのバレルシフタ。2:1 マルチプレクサの 2 段（1 ビットぶん / 2 ビットぶん）で
 * 任意のシフト量を 1 パスで作る、というのがバレルシフタの要点。
 *
 *   入力 d0..d3 = データ / s0,s1 = シフト量  →  出力 y0..y3 = 左に (s1,s0) ビットシフト
 *
 * 押し出された桁は捨て、空いた桁には定数 0 の部品を入れる（論理左シフト）。
 * 手で座標を並べるには大きすぎるので組み立てて返す。27 ゲート・6 入力・4 出力。
 */
function barrelShifter4() {
  const nodes = [];
  const wires = [];
  let id = 0;
  const add = (type, x, y, value, name) => { nodes.push([++id, type, x, y, value, name]); return id; };
  const wire = (from, to, port) => { wires.push([from, 0, to, port]); };

  const COL = { in: 12, not: 100, and1: 222, or1: 332, and2: 452, or2: 562, out: 680 };
  const ROW8 = (i) => 8 + i * 61;      // 8 個並べる列 (AND)
  const ROW4 = (i) => 40 + i * 122;    // 4 個並べる列 (OR・出力)

  /** sel=0 なら lo、sel=1 なら hi を通す 2:1 マルチプレクサ */
  const mux = (lo, hi, sel, notSel, xAnd, xOr, i) => {
    const g0 = add('and', xAnd, ROW8(i * 2));
    const g1 = add('and', xAnd, ROW8(i * 2 + 1));
    const g2 = add('or', xOr, ROW4(i));
    wire(lo, g0, 0); wire(notSel, g0, 1);
    wire(hi, g1, 0); wire(sel, g1, 1);
    wire(g0, g2, 0); wire(g1, g2, 1);
    return g2;
  };

  // データ 4 ビットとシフト量 2 ビット。初期値は 1101 を 2 ビットシフトした状態
  const d = [1, 0, 1, 1].map((v, i) => add('in', COL.in, 8 + i * 78, v, `d${i}`));
  const zero = add('const', COL.in, 320, 0);         // シフトで空いた桁に入れる 0
  const s0 = add('in', COL.in, 378, 0, 's0');
  const s1 = add('in', COL.in, 436, 1, 's1');
  const nS0 = add('not', COL.not, 378);
  const nS1 = add('not', COL.not, 436);
  wire(s0, nS0, 0);
  wire(s1, nS1, 0);

  // 1 段目: s0=1 で 1 ビット / 2 段目: s1=1 で 2 ビット。はみ出す側は 0 を入れる
  const t = [0, 1, 2, 3].map((i) => mux(d[i], i >= 1 ? d[i - 1] : zero, s0, nS0, COL.and1, COL.or1, i));
  const y = [0, 1, 2, 3].map((i) => mux(t[i], i >= 2 ? t[i - 2] : zero, s1, nS1, COL.and2, COL.or2, i));
  for (let i = 0; i < 4; i++) wire(y[i], add('out', COL.out, ROW4(i), 0, `y${i}`), 0);

  // 期待値: データを (s1,s0) ビット左にシフトしたもの (4 ビットに収まらない桁は消える)
  const expect = { y0: [], y1: [], y2: [], y3: [] };
  for (let pat = 0; pat < 64; pat++) {
    const shifted = ((pat & 15) << ((pat >> 4) & 3)) & 15;
    for (let i = 0; i < 4; i++) expect[`y${i}`].push((shifted >> i) & 1);
  }
  return { nodes, wires, expect };
}

// ---------------------------------------------------------------- 保存形式
// 保存・読み込み・共有リンクは全部この圧縮形式を通す。サンプルと同じ形なので
// 「保存した回路」も「サンプル」もまったく同じ経路で読める。
//
//   { nodes: [[id, type, x, y, 値, 名前], …], wires: [[出力ノード, 0, 入力ノード, 端子], …] }
//
// 読み込むデータは URL 経由で他人から来ることもあるので、素朴に信じないで検査する。

const MAX_NODES = 500;
const MAX_NAME = 32;
const COORD_MAX = 4000;

/** 編集中のグラフを圧縮形式にする */
export function packCircuit(graph) {
  return {
    nodes: graph.nodes.map((n) => {
      const row = [n.id, n.type, Math.round(n.x), Math.round(n.y)];
      if (n.value || n.name) row.push(n.value ? 1 : 0);
      if (n.name) row.push(n.name);
      return row;
    }),
    wires: graph.wires.map((w) => [w.from.node, w.from.port, w.to.node, w.to.port]),
  };
}

const coord = (v) => (Number.isFinite(v) ? Math.max(0, Math.min(COORD_MAX, v)) : 0);

/**
 * 圧縮形式を編集可能なグラフに展開する。壊れたデータは理由を付けて弾く。
 * 配線だけは繋ぎ先が無いなど筋の通らないものを黙って捨てる（回路自体は開けたほうが良い）。
 */
export function expandCircuit(c) {
  if (!c || !Array.isArray(c.nodes) || !Array.isArray(c.wires)) {
    throw new Error('回路データの形が違います');
  }
  if (c.nodes.length > MAX_NODES) {
    throw new Error(`部品が多すぎます (${c.nodes.length} > ${MAX_NODES})`);
  }

  const nodes = [];
  const ids = new Set();
  for (const row of c.nodes) {
    if (!Array.isArray(row)) throw new Error('部品データの形が違います');
    const [id, type, x, y, value, name] = row;
    if (!Number.isInteger(id) || id <= 0) throw new Error(`部品の id が不正です: ${id}`);
    if (ids.has(id)) throw new Error(`部品の id が重複しています: ${id}`);
    if (!PARTS[type]) throw new Error(`知らない部品です: ${type}`);
    ids.add(id);
    nodes.push({
      id, type, x: coord(x), y: coord(y), value: value ? 1 : 0,
      ...(typeof name === 'string' && name.length > 0 && name.length <= MAX_NAME ? { name } : {}),
    });
  }

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const wires = [];
  const taken = new Set();
  for (const row of c.wires) {
    if (!Array.isArray(row)) continue;
    const [fn, fp, tn, tp] = row;
    const from = byId.get(fn);
    const to = byId.get(tn);
    if (!from || !to || fp !== 0 || !PARTS[from.type].outs) continue;
    if (!Number.isInteger(tp) || tp < 0 || tp >= PARTS[to.type].ins) continue;
    if (taken.has(`${tn}:${tp}`)) continue;        // 入力端子は 1 本だけ
    taken.add(`${tn}:${tp}`);
    wires.push({ from: { node: fn, port: 0 }, to: { node: tn, port: tp } });
  }
  return { nodes, wires };
}

/** 共有リンクに載せる文字列 (URL に置ける base64) */
export function encodeCircuit(graph) {
  const bytes = new TextEncoder().encode(JSON.stringify(packCircuit(graph)));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** encodeCircuit の逆。壊れていれば例外 */
export function decodeCircuit(text) {
  const bin = atob(String(text).replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
  return expandCircuit(JSON.parse(new TextDecoder().decode(bytes)));
}

const EXPR = {
  not:  ([a]) => `~${a}`,
  and:  ([a, b]) => `${a} & ${b}`,
  or:   ([a, b]) => `${a} | ${b}`,
  xor:  ([a, b]) => `${a} ^ ${b}`,
  nand: ([a, b]) => `~(${a} & ${b})`,
  nor:  ([a, b]) => `~(${a} | ${b})`,
  xnor: ([a, b]) => `~(${a} ^ ${b})`,
};

const ALPHA = 'abcdefghijklmnopqrstuvwxyz';

/** 入力ノードの自動名: a, b, ... z, in26, in27, ... */
function inputName(index) {
  return index < ALPHA.length ? ALPHA[index] : `in${index}`;
}

/**
 * 全ノードに信号名を割り当てる。ノード id → 信号名。
 *
 * 名前付きの端子 (入力・出力・メモリ) が指定した名前を先に押さえ、残りに自動名を振る。
 * 自動名は「まだ空いている番号」を取るので、`a` を手で付けた入力があれば次の自動名は `b` になる。
 * 無効な名前 (識別子でない・予約語・重複) は黙って自動名にまわす ― GUI 側で弾いた上で、
 * 万一通っても Verilog が壊れないようにするための保険。
 */
function assignNames(nodes) {
  const used = new Set([CLOCK]);
  const nameOf = new Map();

  for (const n of nodes) {
    if (!PARTS[n.type].named || !n.name) continue;
    if (checkName(n.name, used)) continue;
    used.add(n.name);
    nameOf.set(n.id, n.name);
  }

  const firstFree = (make) => {
    let k = 0;
    while (used.has(make(k))) k++;
    const name = make(k);
    used.add(name);
    return name;
  };

  for (const n of nodes) {
    if (nameOf.has(n.id)) continue;
    if (n.type === 'in') nameOf.set(n.id, firstFree(inputName));
    else if (n.type === 'out') nameOf.set(n.id, firstFree((k) => `y${k}`));
    else nameOf.set(n.id, firstFree((k) => (k === 0 ? `n${n.id}` : `n${n.id}_${k}`)));
  }
  return nameOf;
}

/**
 * グラフを Verilog に変換する。
 *
 * ゲートの出力は「内部 wire」ではなく **output ポート**として宣言する。
 * 内部の組合せ配線は WASM の local に置かれてメモリに出ないため
 * (layout.js のコメント参照)、そのままでは GUI から値を読めない。
 * output にしておけば全ての配線を観測できて、線に値を色付けできる。
 *
 * 入力端子が 1 つでも未配線のノードと、その下流は「未完成」として除外する。
 * 組合せループは除外しない ― 配線が全部埋まっている以上グラフとしては完成形で、
 * ループの検出は schedule.js の仕事なので、そのままコンパイラに渡してエラーを出させる。
 *
 * メモリ (DFF) を置くと `input clk` と `always @(posedge clk)` が生える。クロックは
 * 全体で 1 本の共有で、エッジは sim.step() が打つので端子としては見せない。
 *
 * @param {{nodes: Array, wires: Array}} graph
 * @param {{top?: string}} [opts]
 * @returns {{source: string|null, signalOf: Map<number,string>, inputs: Array,
 *            outputs: Array, regs: Array, incomplete: Set<number>}}
 */
export function toVerilog(graph, opts = {}) {
  const top = opts.top ?? 'sketch';
  const nodes = graph.nodes ?? [];
  const byId = new Map(nodes.map((n) => [n.id, n]));

  // (ノード, 入力端子) → その端子を駆動しているノードの出力
  const driver = new Map();
  for (const w of graph.wires ?? []) {
    if (!byId.has(w.from.node) || !byId.has(w.to.node)) continue;
    driver.set(`${w.to.node}:${w.to.port}`, w.from);
  }

  // 未配線の入力端子を持つノードを起点に、下流へ「未完成」を伝播させる
  const incomplete = new Set();
  for (const n of nodes) {
    const spec = PARTS[n.type];
    for (let p = 0; p < spec.ins; p++) {
      if (!driver.has(`${n.id}:${p}`)) { incomplete.add(n.id); break; }
    }
  }
  for (let changed = true; changed;) {
    changed = false;
    for (const n of nodes) {
      if (incomplete.has(n.id)) continue;
      for (let p = 0; p < PARTS[n.type].ins; p++) {
        if (incomplete.has(driver.get(`${n.id}:${p}`).node)) {
          incomplete.add(n.id);
          changed = true;
          break;
        }
      }
    }
  }

  // 信号名の割り当て。名前が付いている端子はそれを優先し、残りに自動名を振る。
  // 自動名は入力が a,b,... / 出力ノードが y0,y1,... / ゲートとメモリが n<id>。
  const signalOf = assignNames(nodes);
  const inputs = [];
  const outputs = [];
  for (const n of nodes) {
    const name = signalOf.get(n.id);
    if (n.type === 'in') {
      inputs.push({ node: n.id, name });
    } else if (incomplete.has(n.id)) {
      continue;
    } else if (n.type === 'out') {
      outputs.push({ node: n.id, name, kind: 'out' });
    } else {
      const spec = PARTS[n.type];
      outputs.push({ node: n.id, name, kind: spec.reg ? 'reg' : spec.konst ? 'const' : 'gate' });
    }
  }

  const regs = outputs.filter((o) => o.kind === 'reg');
  if (inputs.length === 0 && outputs.length === 0) {
    return { source: null, signalOf, inputs, outputs, regs, incomplete };
  }

  // メモリを 1 個でも使うなら暗黙のクロックが生える。エッジは step() が打つので端子には出さない
  const ports = [
    ...(regs.length ? [`  input  ${CLOCK}`] : []),
    ...inputs.map((i) => `  input  ${i.name}`),
    ...outputs.map((o) => `  output ${o.kind === 'reg' ? 'reg ' : ''}${o.name}`),
  ];

  const argsOf = (n) => {
    const args = [];
    for (let p = 0; p < PARTS[n.type].ins; p++) {
      args.push(signalOf.get(driver.get(`${n.id}:${p}`).node));
    }
    return args;
  };

  const body = [];
  for (const o of outputs) {
    if (o.kind === 'reg') continue;
    const n = byId.get(o.node);
    if (o.kind === 'const') {
      body.push(`  assign ${o.name} = 1'b${n.value ? 1 : 0};`);
      continue;
    }
    const args = argsOf(n);
    body.push(`  assign ${o.name} = ${n.type === 'out' ? args[0] : EXPR[n.type](args)};`);
  }
  for (const o of regs) {
    body.push(`  always @(posedge ${CLOCK})`);
    body.push(`    ${o.name} <= ${argsOf(byId.get(o.node))[0]};`);
  }

  const decl = `module ${top}(\n${ports.join(',\n')}\n);\n`;
  const source = `${decl}${body.map((l) => `${l}\n`).join('')}endmodule\n`;
  return { source, signalOf, inputs, outputs, regs, incomplete };
}
