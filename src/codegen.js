// ネットリスト → WASM バイナリ
//
// 生成されるモジュール:
//   (memory 1)                        … エクスポート。ホストが入出力を読み書きする
//   (func (export "eval"))            … 組合せ論理だけを評価 (レジスタは更新しない)
//   (func (export "commit"))          … 次状態 → Q の一括転送 (= クロックエッジ)
//   (func (export "step"))            … 1 クロック。終了時に組合せ出力は確定済み
//   (func (export "run") (param i32)) … n クロック
//
// eval を分離してあるのは、入力を変えた直後に「まだクロックは打たずに
// 組合せ出力だけ落ち着かせる」操作が必要になるため。純粋な組合せ回路では
// step() ではなく eval() が本来の操作になる。
//
// step は eval → commit → eval。最後の eval がないと、クロックエッジ直後の
// 組合せ出力がエッジ前の状態から計算された値のまま残る。
// run(n) は eval → (commit → eval) × n として、この余分な eval を畳んでいる
// (n+1 回の eval で n クロック分。step を n 回呼ぶより 1 回あたり 1 eval 少ない)。
//
// eval() の構造は完全に直線コード:
//   1. 入力ポートとレジスタ Q を memory から local に読み込む
//   2. トポロジカル順にゲートを評価 (local → local)
//   3. 出力ポートと「レジスタの次状態」を memory に書き出す
// 3 を最後にまとめ、かつ次状態を専用スロットに置くことで、
// レジスタの同時代入セマンティクスが構造的に保証される。

import { uleb, sleb, sleb64, vec, section, name as encName } from './leb128.js';

const OP = {
  end: 0x0b,
  block: 0x02,
  loop: 0x03,
  br: 0x0c,
  br_if: 0x0d,
  call: 0x10,
  local_get: 0x20,
  local_set: 0x21,
  i32_const: 0x41,
  i32_eqz: 0x45,
  i32_sub: 0x6b,
  i32_eq: 0x46,
  if_: 0x04,
  i64_const: 0x42,
  i64_load: 0x29,
  i64_store: 0x37,
  i64_and: 0x83,
  i64_or: 0x84,
  i64_xor: 0x85,
};

const I32 = 0x7f;
const I64 = 0x7e;
const ALIGN_8 = 3; // log2(8)

const BINOP = { and: OP.i64_and, or: OP.i64_or, xor: OP.i64_xor };

const F_EVAL = 0;
const F_COMMIT = 1;
const F_STEP = 2;
const F_RUN = 3;

export function emitWasm(netlist, order, layout) {
  const { nets, gates, regs } = netlist;
  const { slots, regNext } = layout;
  // 4 値では 1 ネットが 2 面。local も 2 本ずつ使い、**不定の面は値の面から
  // nets.length ずらした番号**に置く。メモリ側は値の面の 8 バイト後ろ
  // (どちらも src/fourstate.js の符号化に合わせてある)。
  const xstate = !!layout.xstate;
  const XL = nets.length;          // 不定の面の local 番号のずらし幅
  const localCount = xstate ? nets.length * 2 : nets.length;

  // ---- eval 本体 ----
  const code = [];
  const emit = (...bytes) => code.push(...bytes);
  const get = (netId) => emit(OP.local_get, ...uleb(netId));
  const set = (netId) => emit(OP.local_set, ...uleb(netId));
  const getU = (netId) => emit(OP.local_get, ...uleb(XL + netId));
  const setU = (netId) => emit(OP.local_set, ...uleb(XL + netId));
  const allOnes = () => emit(OP.i64_const, ...sleb64(-1n));
  const zero = () => emit(OP.i64_const, ...sleb64(0n));
  const inv = () => { allOnes(); emit(OP.i64_xor); };          // 直前の値を反転

  const loadInto = (netId, offset) => {
    emit(OP.i32_const, ...sleb(0));
    emit(OP.i64_load, ...uleb(ALIGN_8), ...uleb(offset));
    set(netId);
    if (!xstate) return;
    emit(OP.i32_const, ...sleb(0));
    emit(OP.i64_load, ...uleb(ALIGN_8), ...uleb(offset + 8));
    setU(netId);
  };

  // --- 1. 状態の読み込み ---
  for (const n of layout.inputNets) loadInto(n, slots.get(n));
  for (const r of regs) loadInto(r.q, slots.get(r.q));

  // --- 2. ゲートの評価 ---
  for (const gi of order) {
    const g = gates[gi];
    if (xstate) { emitGate4(g); continue; }
    switch (g.op) {
      case 'const':
        if (g.value) allOnes();
        else zero();
        set(g.out);
        break;
      case 'buf':
        get(g.in[0]);
        set(g.out);
        break;
      case 'not':
        get(g.in[0]);
        inv();
        set(g.out);
        break;
      case 'and':
      case 'or':
      case 'xor':
        get(g.in[0]);
        for (let k = 1; k < g.in.length; k++) {
          get(g.in[k]);
          emit(BINOP[g.op]);
        }
        set(g.out);
        break;
      case 'mux': {
        // sel ? a : b  ==  (a & sel) | (b & ~sel)
        const [sel, a, b] = g.in;
        get(a);
        get(sel);
        emit(OP.i64_and);
        get(b);
        get(sel);
        inv();
        emit(OP.i64_and);
        emit(OP.i64_or);
        set(g.out);
        break;
      }
      default:
        throw new Error(`codegen: 未知のゲート op '${g.op}' (out=${nets[g.out]?.name})`);
    }
  }

  /**
   * 4 値のゲート 1 個。式は src/fourstate.js が唯一の仕様で、ここはそれを
   * i64 命令に写しただけ。**必ず不定の面を先に書く** ―― n 入力を畳むときは
   * 出力の local を累算器に使うので、値の面を先に潰すと不定の面の式が読む
   * 「畳む前の値」が消えてしまう (不定の面の式だけが値の面を必要とする)。
   */
  function emitGate4(g) {
    const out = g.out;
    if (g.op === 'const') {
      if (g.value === 'x') { allOnes(); setU(out); zero(); set(out); return; }
      zero(); setU(out);
      if (g.value) allOnes(); else zero();
      set(out);
      return;
    }
    if (g.op === 'buf' || g.op === 'not') {
      const a = g.in[0];
      getU(a); setU(out);
      get(a); if (g.op === 'not') inv(); set(out);
      return;
    }
    if (g.op === 'isx') {
      // 「x か」を確実な 0 / 1 として取り出す。不定の面を値の面へ移すだけ
      const a = g.in[0];
      zero(); setU(out);
      getU(a); set(out);
      return;
    }
    if (g.op === 'mux') {
      const [s, a, b] = g.in;
      // u = (~s.u & ((s.v & a.u) | (~s.v & b.u))) | (s.u & (a.u | b.u | (a.v ^ b.v)))
      getU(s); inv();
      get(s); getU(a); emit(OP.i64_and);
      get(s); inv(); getU(b); emit(OP.i64_and);
      emit(OP.i64_or);
      emit(OP.i64_and);
      getU(s);
      getU(a); getU(b); emit(OP.i64_or);
      get(a); get(b); emit(OP.i64_xor);
      emit(OP.i64_or);
      emit(OP.i64_and);
      emit(OP.i64_or);
      setU(out);
      // v = (s.v & a.v) | (~s.v & b.v)
      get(s); get(a); emit(OP.i64_and);
      get(s); inv(); get(b); emit(OP.i64_and);
      emit(OP.i64_or);
      set(out);
      return;
    }
    // and / or / xor は 2 入力ずつ畳む。出力の local を累算器にする
    let acc = g.in[0];
    for (let k = 1; k < g.in.length; k++) {
      const b = g.in[k];
      emitBin4(g.op, acc, b, out);
      acc = out;
    }
    if (g.in.length === 1) { getU(acc); setU(out); get(acc); set(out); }
  }

  function emitBin4(op, a, b, out) {
    if (op === 'xor') {
      getU(a); getU(b); emit(OP.i64_or); setU(out);
      get(a); get(b); emit(OP.i64_xor); set(out);
      return;
    }
    // and … u = (a.u|b.u) & (a.v|a.u) & (b.v|b.u)   … どちらも「確実な 0」でない
    // or  … u = (a.u|b.u) & (~a.v|a.u) & (~b.v|b.u) … どちらも「確実な 1」でない
    const flip = op === 'or';
    getU(a); getU(b); emit(OP.i64_or);
    get(a); if (flip) inv(); getU(a); emit(OP.i64_or);
    emit(OP.i64_and);
    get(b); if (flip) inv(); getU(b); emit(OP.i64_or);
    emit(OP.i64_and);
    setU(out);
    get(a); get(b); emit(BINOP[op]); set(out);
  }

  // --- 3. 書き出し (出力ポート + レジスタ次状態) ---
  const storeFromLocal = (offset, valueNet) => {
    emit(OP.i32_const, ...sleb(0));
    get(valueNet);
    emit(OP.i64_store, ...uleb(ALIGN_8), ...uleb(offset));
    if (!xstate) return;
    emit(OP.i32_const, ...sleb(0));
    getU(valueNet);
    emit(OP.i64_store, ...uleb(ALIGN_8), ...uleb(offset + 8));
  };
  for (const n of layout.outputNets) storeFromLocal(slots.get(n), n);
  regs.forEach((r, i) => storeFromLocal(regNext[i], r.d));

  // 非同期リセット: クロックを待たずに Q を上書きする。
  // Q の読み込みは 1 で済んでいるので、ここで書いても今回の eval には影響しない。
  regs.forEach((r) => {
    if (r.qAsync != null && r.qAsync !== r.q) storeFromLocal(slots.get(r.q), r.qAsync);
  });

  emit(OP.end);

  const evalBody = [...vec([[...uleb(localCount), I64]]), ...code];

  // ---- commit(domain) 本体: next スロット → Q スロットの一括コピー ----
  //
  // **クロックドメインごとに分かれる。** 引数のドメイン番号と一致したブロックだけを
  // 通し、別のクロックのレジスタは動かさない。ドメインが 1 個なら `if` は
  // 畳まずにそのまま置く (1 個ぶんの比較なので、これまでとの差は数バイト)。
  const domains = Math.max(1, layout.clocks.length);
  const commitCode = [];
  const copyWord = (from, to) => {
    commitCode.push(OP.i32_const, ...sleb(0));                                  // 宛先アドレス
    commitCode.push(OP.i32_const, ...sleb(0));                                  // 元アドレス
    commitCode.push(OP.i64_load, ...uleb(ALIGN_8), ...uleb(from));
    commitCode.push(OP.i64_store, ...uleb(ALIGN_8), ...uleb(to));
  };
  for (let d = 0; d < domains; d++) {
    const mine = regs.map((r, i) => [r, i]).filter(([r]) => (r.domain ?? 0) === d);
    if (mine.length === 0) continue;
    commitCode.push(OP.local_get, ...uleb(0));       // ドメイン番号
    commitCode.push(OP.i32_const, ...sleb(d));
    commitCode.push(OP.i32_eq);
    commitCode.push(OP.if_, 0x40);
    for (const [r, i] of mine) {
      copyWord(regNext[i], slots.get(r.q));
      if (xstate) copyWord(regNext[i] + 8, slots.get(r.q) + 8);
    }
    commitCode.push(OP.end);
  }
  commitCode.push(OP.end);
  const commitBody = [...vec([]), ...commitCode];

  // ---- step(domain) 本体 ----
  const stepBody = [
    ...vec([]),
    OP.call, ...uleb(F_EVAL),
    OP.local_get, ...uleb(0),
    OP.call, ...uleb(F_COMMIT),
    OP.call, ...uleb(F_EVAL),
    OP.end,
  ];

  // ---- run(domain, n) 本体: eval → (commit → eval) × n ----
  // local 0 = ドメイン番号、local 1 = 残り回数
  const runBody = [
    ...vec([]),
    OP.call, ...uleb(F_EVAL),
    OP.block, 0x40,
    OP.loop, 0x40,
    OP.local_get, ...uleb(1),
    OP.i32_eqz,
    OP.br_if, ...uleb(1),
    OP.local_get, ...uleb(0),
    OP.call, ...uleb(F_COMMIT),
    OP.call, ...uleb(F_EVAL),
    OP.local_get, ...uleb(1),
    OP.i32_const, ...sleb(1),
    OP.i32_sub,
    OP.local_set, ...uleb(1),
    OP.br, ...uleb(0),
    OP.end,
    OP.end,
    OP.end,
  ];

  // ---- セクション組み立て ----
  const typeSec = section(1, vec([
    [0x60, ...uleb(0), ...uleb(0)],       // type 0: () -> ()
    [0x60, ...uleb(1), I32, ...uleb(0)],  // type 1: (i32) -> ()
    [0x60, ...uleb(2), I32, I32, ...uleb(0)],  // type 2: (i32, i32) -> ()
  ]));
  // eval: () -> ()、commit / step: (domain) -> ()、run: (domain, n) -> ()
  const funcSec = section(3, vec([[0], [1], [1], [2]].map((t) => [...uleb(t[0])])));
  const memSec = section(5, vec([[0x00, ...uleb(layout.pages)]]));
  const exportSec = section(7, vec([
    [...encName('eval'), 0x00, ...uleb(F_EVAL)],
    [...encName('commit'), 0x00, ...uleb(F_COMMIT)],
    [...encName('step'), 0x00, ...uleb(F_STEP)],
    [...encName('run'), 0x00, ...uleb(F_RUN)],
    [...encName('memory'), 0x02, ...uleb(0)],
  ]));
  const codeSec = section(10, vec(
    [evalBody, commitBody, stepBody, runBody].map((b) => [...uleb(b.length), ...b]),
  ));

  // initial を書いた回路だけデータセクションが付く。これでモジュール単体が
  // 初期状態を運ぶので、instantiate しただけで正しい値から始まる (他のホストでも)。
  // 何も書いていない回路のバイト列はこれまでと 1 バイトも変わらない。
  const dataSec = layout.initWords.length ? section(11, vec(initSegments(layout))) : [];

  return new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, // \0asm
    0x01, 0x00, 0x00, 0x00, // version 1
    ...typeSec,
    ...funcSec,
    ...memSec,
    ...exportSec,
    ...codeSec,
    ...dataSec,
  ]);
}

/**
 * 初期状態のデータセグメント。1 個のセグメントは
 *   0x00 (memory 0 に置く) + オフセット式 (i32.const N / end) + 長さ付きバイト列。
 * 続きのスロットは 1 個にまとめる ―― セグメントの前置きだけで 12 バイトほどあるので、
 * 32 ビットのレジスタを 1 ビットずつ出すと本体より前置きの方が大きくなる。
 */
function initSegments(layout) {
  const words = [...layout.initWords].sort((a, b) => a[0] - b[0]);
  const runs = [];
  for (const [off, value] of words) {
    const last = runs[runs.length - 1];
    if (last && off === last.off + last.bytes.length) last.bytes.push(...leBytes(value));
    else runs.push({ off, bytes: leBytes(value) });
  }
  return runs.map((r) => [
    0x00, OP.i32_const, ...sleb(r.off), OP.end, ...uleb(r.bytes.length), ...r.bytes,
  ]);
}

/** i64 をリトルエンディアンの 8 バイトに */
function leBytes(value) {
  const out = [];
  let v = BigInt(value);
  for (let i = 0; i < 8; i++) { out.push(Number(v & 0xffn)); v >>= 8n; }
  return out;
}
