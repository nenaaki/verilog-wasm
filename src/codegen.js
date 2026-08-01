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

  // ---- eval 本体 ----
  const code = [];
  const emit = (...bytes) => code.push(...bytes);
  const get = (netId) => emit(OP.local_get, ...uleb(netId));
  const set = (netId) => emit(OP.local_set, ...uleb(netId));
  const allOnes = () => emit(OP.i64_const, ...sleb64(-1n));

  const loadInto = (netId, offset) => {
    emit(OP.i32_const, ...sleb(0));
    emit(OP.i64_load, ...uleb(ALIGN_8), ...uleb(offset));
    set(netId);
  };

  // --- 1. 状態の読み込み ---
  for (const n of layout.inputNets) loadInto(n, slots.get(n));
  for (const r of regs) loadInto(r.q, slots.get(r.q));

  // --- 2. ゲートの評価 ---
  for (const gi of order) {
    const g = gates[gi];
    switch (g.op) {
      case 'const':
        if (g.value) allOnes();
        else emit(OP.i64_const, ...sleb64(0n));
        set(g.out);
        break;
      case 'buf':
        get(g.in[0]);
        set(g.out);
        break;
      case 'not':
        get(g.in[0]);
        allOnes();
        emit(OP.i64_xor);
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
        allOnes();
        emit(OP.i64_xor);
        emit(OP.i64_and);
        emit(OP.i64_or);
        set(g.out);
        break;
      }
      default:
        throw new Error(`codegen: 未知のゲート op '${g.op}' (out=${nets[g.out]?.name})`);
    }
  }

  // --- 3. 書き出し (出力ポート + レジスタ次状態) ---
  const storeFromLocal = (offset, valueNet) => {
    emit(OP.i32_const, ...sleb(0));
    get(valueNet);
    emit(OP.i64_store, ...uleb(ALIGN_8), ...uleb(offset));
  };
  for (const n of layout.outputNets) storeFromLocal(slots.get(n), n);
  regs.forEach((r, i) => storeFromLocal(regNext[i], r.d));

  // 非同期リセット: クロックを待たずに Q を上書きする。
  // Q の読み込みは 1 で済んでいるので、ここで書いても今回の eval には影響しない。
  regs.forEach((r) => {
    if (r.qAsync != null && r.qAsync !== r.q) storeFromLocal(slots.get(r.q), r.qAsync);
  });

  emit(OP.end);

  const evalBody = [...vec([[...uleb(nets.length), I64]]), ...code];

  // ---- commit 本体: next スロット → Q スロットの一括コピー ----
  const commitCode = [];
  regs.forEach((r, i) => {
    commitCode.push(OP.i32_const, ...sleb(0));                                  // 宛先アドレス
    commitCode.push(OP.i32_const, ...sleb(0));                                  // 元アドレス
    commitCode.push(OP.i64_load, ...uleb(ALIGN_8), ...uleb(regNext[i]));
    commitCode.push(OP.i64_store, ...uleb(ALIGN_8), ...uleb(slots.get(r.q)));
  });
  commitCode.push(OP.end);
  const commitBody = [...vec([]), ...commitCode];

  // ---- step 本体 ----
  const stepBody = [
    ...vec([]),
    OP.call, ...uleb(F_EVAL),
    OP.call, ...uleb(F_COMMIT),
    OP.call, ...uleb(F_EVAL),
    OP.end,
  ];

  // ---- run(n) 本体: eval → (commit → eval) × n ----
  const runBody = [
    ...vec([]),
    OP.call, ...uleb(F_EVAL),
    OP.block, 0x40,
    OP.loop, 0x40,
    OP.local_get, ...uleb(0),
    OP.i32_eqz,
    OP.br_if, ...uleb(1),
    OP.call, ...uleb(F_COMMIT),
    OP.call, ...uleb(F_EVAL),
    OP.local_get, ...uleb(0),
    OP.i32_const, ...sleb(1),
    OP.i32_sub,
    OP.local_set, ...uleb(0),
    OP.br, ...uleb(0),
    OP.end,
    OP.end,
    OP.end,
  ];

  // ---- セクション組み立て ----
  const typeSec = section(1, vec([
    [0x60, ...uleb(0), ...uleb(0)],       // type 0: () -> ()
    [0x60, ...uleb(1), I32, ...uleb(0)],  // type 1: (i32) -> ()
  ]));
  const funcSec = section(3, vec([[0], [0], [0], [1]].map((t) => [...uleb(t[0])])));
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

  return new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, // \0asm
    0x01, 0x00, 0x00, 0x00, // version 1
    ...typeSec,
    ...funcSec,
    ...memSec,
    ...exportSec,
    ...codeSec,
  ]);
}
