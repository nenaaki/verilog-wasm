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
  // 保存した回路をまるごと 1 個の部品にしたもの。端子の数は中身で決まる (insOf / outsOf)
  block: { label: '回路部品', glyph: 'BLOCK', ins: 0, outs: 0, block: true },
  // 平坦化のときだけ作る内部部品。ブロックの端子と中身をつなぐ中継で assign x = y; になる
  alias: { label: '中継', glyph: '', ins: 1, outs: 1, internal: true },
};

/** その部品の入力端子の数。ブロックだけ中身で変わる */
export const insOf = (node) =>
  (node.type === 'block' ? (node._ports?.inputs.length ?? 0) : PARTS[node.type].ins);

/** その部品の出力端子の数 */
export const outsOf = (node) =>
  (node.type === 'block' ? (node._ports?.outputs.length ?? 0) : PARTS[node.type].outs);

/** メモリを 1 個でも使うときに生える暗黙のクロック入力 */
export const CLOCK = 'clk';

// 保存形式の上限。サンプルの組み立てより先に評価される必要がある
const MAX_NODES = 500;
const MAX_NAME = 32;
const COORD_MAX = 4000;
const MAX_DEPTH = 8;          // 部品の入れ子の深さ
const MAX_FLAT_NODES = 4000;  // 平坦化した後のノード数

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

// ---------------------------------------------------------------- 保存形式
// 保存・読み込み・共有リンクは全部この圧縮形式を通す。サンプルと同じ形なので
// 「保存した回路」も「サンプル」もまったく同じ経路で読める。
//
//   { nodes: [[id, type, x, y, 値, 名前, 付加情報], …],
//     wires: [[出力ノード, 端子, 入力ノード, 端子], …] }
//
// 「付加情報」は回路部品 (block) だけが使う { ref, def }。ref は元になった回路の名前
// (表示用) で、def は**中身をそのまま埋め込んだ圧縮形式**。参照ではなく埋め込みなのは
// 保存や共有リンクを単体で完結させるため。おかげで相手の localStorage に元の回路が
// 無くても開ける。元を直したときは「部品を更新」で埋め込みを差し替える。
//
// 読み込むデータは URL 経由で他人から来ることもあるので、素朴に信じないで検査する。


/** 編集中のグラフを圧縮形式にする */
export function packCircuit(graph) {
  return {
    nodes: graph.nodes.map((n) => {
      const row = [n.id, n.type, Math.round(n.x), Math.round(n.y)];
      if (n.type === 'block') {
        row.push(n.value ? 1 : 0, n.name ?? null, { ref: n.ref ?? null, def: n.def });
      } else {
        if (n.value || n.name) row.push(n.value ? 1 : 0);
        if (n.name) row.push(n.name);
      }
      return row;
    }),
    wires: graph.wires.map((w) => [w.from.node, w.from.port, w.to.node, w.to.port]),
  };
}

const coord = (v) => (Number.isFinite(v) ? Math.max(0, Math.min(COORD_MAX, v)) : 0);

/**
 * 回路部品の端子。中身の入力ノード・出力ノードが並び順のまま端子になる。
 * 名前もそのまま端子名になるので、中身に名前を付けておくと部品が読みやすくなる。
 */
export function blockPorts(def, depth = 0) {
  const sub = expandCircuit(def, depth);
  const names = assignNames(sub.nodes);
  return {
    inputs: sub.nodes.filter((n) => n.type === 'in').map((n) => names.get(n.id)),
    outputs: sub.nodes.filter((n) => n.type === 'out').map((n) => names.get(n.id)),
  };
}

/**
 * 圧縮形式を編集可能なグラフに展開する。壊れたデータは理由を付けて弾く。
 * 配線だけは繋ぎ先が無いなど筋の通らないものを黙って捨てる（回路自体は開けたほうが良い）。
 */
export function expandCircuit(c, depth = 0) {
  if (depth > MAX_DEPTH) throw new Error(`回路部品の入れ子が深すぎます (${MAX_DEPTH} 段まで)`);
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
    const [id, type, x, y, value, name, extra] = row;
    if (!Number.isInteger(id) || id <= 0) throw new Error(`部品の id が不正です: ${id}`);
    if (ids.has(id)) throw new Error(`部品の id が重複しています: ${id}`);
    if (!PARTS[type]) throw new Error(`知らない部品です: ${type}`);
    if (PARTS[type].internal) throw new Error(`${type} は内部用の部品なので置けません`);
    ids.add(id);
    const node = {
      id, type, x: coord(x), y: coord(y), value: value ? 1 : 0,
      ...(typeof name === 'string' && name.length > 0 && name.length <= MAX_NAME ? { name } : {}),
    };
    if (type === 'block') {
      if (!extra || typeof extra !== 'object') throw new Error('回路部品に中身がありません');
      node.def = extra.def;
      node.ref = typeof extra.ref === 'string' ? extra.ref : null;
      node._ports = blockPorts(node.def, depth + 1);   // ここで中身も検査される
    }
    nodes.push(node);
  }

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const wires = [];
  const taken = new Set();
  for (const row of c.wires) {
    if (!Array.isArray(row)) continue;
    const [fn, fp, tn, tp] = row;
    const from = byId.get(fn);
    const to = byId.get(tn);
    if (!from || !to) continue;
    if (!Number.isInteger(fp) || fp < 0 || fp >= outsOf(from)) continue;
    if (!Number.isInteger(tp) || tp < 0 || tp >= insOf(to)) continue;
    if (taken.has(`${tn}:${tp}`)) continue;        // 入力端子は 1 本だけ
    taken.add(`${tn}:${tp}`);
    wires.push({ from: { node: fn, port: fp }, to: { node: tn, port: tp } });
  }
  return { nodes, wires };
}

// ------------------------------------------------------------ 平坦化
// 回路部品は「中身を親に取り込む」ことで実現する。Verilog のモジュール階層には
// 手を付けず、生成されるソースは 1 個の平坦な module のままになる。
//
// 部品の端子ごとに中継ノード (alias = assign x = y;) を 1 個作り、
//   親の配線 → 中継 → 中身        (入力端子)
//   中身 → 中継 → 親の配線        (出力端子)
// と繋ぐ。中身の in / out ノードはこの中継に置き換えて消える。
//
// 中継を挟むのは順序を気にしなくて済むから。部品同士を相互に繋いだ場合も
// ただのグラフの循環になるので、組合せループとして schedule.js が見つけてくれる。

/**
 * ブロックを展開した平坦なグラフを作る。
 * @returns {{nodes, wires, outletOf: Map<string, number>}}
 *   outletOf は `${ブロックの id}:${出力端子}` → 値を観測できるノード id
 */
export function flattenGraph(graph) {
  const ctx = {
    nodes: [],
    wires: [],
    outletOf: new Map(),
    next: Math.max(0, ...graph.nodes.map((n) => n.id)) + 1,
    idGen() { return this.next++; },
  };
  copyLevel(graph, ctx, '', 0, null, null);
  return { nodes: ctx.nodes, wires: ctx.wires, outletOf: ctx.outletOf };
}

/**
 * 1 段ぶんを平坦グラフに写す。
 * @param {Map|null} inAlias  中身の入力ノード id → 親が作った中継ノード id (最上位は null)
 * @param {Map|null} outAlias 中身の出力ノード id → 親が作った中継ノード id (最上位は null)
 */
function copyLevel(g, ctx, prefix, depth, inAlias, outAlias) {
  if (depth > MAX_DEPTH) throw new Error(`回路部品の入れ子が深すぎます (${MAX_DEPTH} 段まで)`);

  const map = new Map();          // この段のノード id → 平坦グラフの id
  const pinIn = new Map();        // `${ブロック id}:${入力端子}` → 中継ノード id
  const pinOut = new Map();       // `${ブロック id}:${出力端子}` → 中継ノード id

  const push = (node) => {
    if (ctx.nodes.length >= MAX_FLAT_NODES) {
      throw new Error(`部品を広げた後の部品数が多すぎます (${MAX_FLAT_NODES} まで)`);
    }
    ctx.nodes.push(node);
    return node.id;
  };

  for (const n of g.nodes) {
    if (n.type === 'block') continue;                     // 後でまとめて広げる
    if (inAlias && n.type === 'in') { map.set(n.id, inAlias.get(n.id)); continue; }
    if (outAlias && n.type === 'out') { map.set(n.id, outAlias.get(n.id)); continue; }
    const id = prefix === '' ? n.id : ctx.idGen();        // 最上位は id をそのまま保つ
    map.set(n.id, id);
    push({
      ...n, id,
      // 部品の中の信号は u<インスタンス>_ が付いた名前になる (生成 Verilog を読むため)
      ...(prefix ? { name: `${prefix}${n.name ?? `n${n.id}`}` } : {}),
    });
  }

  for (const n of g.nodes) {
    if (n.type !== 'block') continue;
    const ports = n._ports ?? blockPorts(n.def, depth + 1);
    const sub = expandCircuit(n.def, depth + 1);
    const subIn = sub.nodes.filter((x) => x.type === 'in');
    const subOut = sub.nodes.filter((x) => x.type === 'out');
    const ia = new Map();
    const oa = new Map();
    const tag = `${prefix}u${n.id}_`;

    subIn.forEach((s, i) => {
      const id = push({ id: ctx.idGen(), type: 'alias', x: n.x, y: n.y, value: 0,
        name: `${tag}${ports.inputs[i]}` });
      ia.set(s.id, id);
      pinIn.set(`${n.id}:${i}`, id);
    });
    subOut.forEach((s, j) => {
      const id = push({ id: ctx.idGen(), type: 'alias', x: n.x, y: n.y, value: 0,
        name: `${tag}${ports.outputs[j]}` });
      oa.set(s.id, id);
      pinOut.set(`${n.id}:${j}`, id);
      if (prefix === '') ctx.outletOf.set(`${n.id}:${j}`, id);   // 画面から値を読むのは最上位だけ
    });

    copyLevel(sub, ctx, tag, depth + 1, ia, oa);
  }

  const typeOf = new Map(g.nodes.map((n) => [n.id, n.type]));   // 配線ごとに探すと二乗になる
  for (const w of g.wires) {
    const src = typeOf.get(w.from.node) === 'block'
      ? pinOut.get(`${w.from.node}:${w.from.port}`)
      : map.get(w.from.node);
    const dst = typeOf.get(w.to.node) === 'block'
      ? { node: pinIn.get(`${w.to.node}:${w.to.port}`), port: 0 }
      : { node: map.get(w.to.node), port: w.to.port };
    if (src === undefined || dst.node === undefined) continue;   // 端子の無いブロックなど
    ctx.wires.push({ from: { node: src, port: 0 }, to: dst });
  }
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
  alias: ([a]) => a,          // 回路部品の端子をつなぐ中継
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
    if (!n.name) continue;
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
  // 回路部品があれば先に中身を取り込んで平坦にする。以降はブロックを知らなくて済む
  const hasBlock = (graph.nodes ?? []).some((n) => n.type === 'block');
  const flat = hasBlock ? flattenGraph(graph) : { ...graph, outletOf: new Map() };
  const outletOf = flat.outletOf ?? new Map();
  const nodes = flat.nodes ?? [];
  const byId = new Map(nodes.map((n) => [n.id, n]));

  // (ノード, 入力端子) → その端子を駆動しているノードの出力
  const driver = new Map();
  for (const w of flat.wires ?? []) {
    if (!byId.has(w.from.node) || !byId.has(w.to.node)) continue;
    driver.set(`${w.to.node}:${w.to.port}`, w.from);
  }

  // 未配線の入力端子を持つノードを起点に、下流へ「未完成」を伝播させる
  const incomplete = new Set();
  for (const n of nodes) {
    for (let p = 0; p < insOf(n); p++) {
      if (!driver.has(`${n.id}:${p}`)) { incomplete.add(n.id); break; }
    }
  }
  for (let changed = true; changed;) {
    changed = false;
    for (const n of nodes) {
      if (incomplete.has(n.id)) continue;
      for (let p = 0; p < insOf(n); p++) {
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
    return { source: null, signalOf, inputs, outputs, regs, incomplete, outletOf };
  }

  // メモリを 1 個でも使うなら暗黙のクロックが生える。エッジは step() が打つので端子には出さない
  const ports = [
    ...(regs.length ? [`  input  ${CLOCK}`] : []),
    ...inputs.map((i) => `  input  ${i.name}`),
    ...outputs.map((o) => `  output ${o.kind === 'reg' ? 'reg ' : ''}${o.name}`),
  ];

  const argsOf = (n) => {
    const args = [];
    for (let p = 0; p < insOf(n); p++) {
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
  return { source, signalOf, inputs, outputs, regs, incomplete, outletOf };
}
