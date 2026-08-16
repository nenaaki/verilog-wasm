// 4 値 (0 / 1 / x) の符号化と、ゲート 1 個ぶんの計算式。
//
// **ここが唯一の仕様。** WASM を吐く codegen.js も、JS の参照実装 interp.js も、
// この式をそのままなぞる。2 つが食い違っていないことはランダム差分テストが見る。
//
// ---- 符号化 -----------------------------------------------------------------
//
// ネット 1 本を 2 枚の面で持つ。どちらも 64 レーンぶんの i64:
//
//   v … 値の面
//   u … 不定の面 (1 なら x)
//
//   0 = (v=0, u=0)   1 = (v=1, u=0)   x = (v=*, u=1)
//
// **u=1 のとき v は意味を持たない** (掃除しない)。掃除すると not のたびに
// 正規化が要るのに、u が立っていれば下流の式で必ず u が勝つので見なくて済む。
// 外に見せるときだけ `v & ~u` にして、x のビットは 0 として読める形に揃える。
//
// z は入れていない。この処理系は多重ドライブをエラーにしていて `inout` も
// `bufif` も無いので、値としての z はどこからも来ない (README「x / z」参照)。
//
// ---- 計算式 -----------------------------------------------------------------
//
// 考え方はどれも同じで、「**確実に決まる入力があれば結果も決まる**」を書き下す:
//
//   and … 片方でも確実な 0 なら結果は 0。両方が確実な 1 なら 1。それ以外は x
//   or  … 片方でも確実な 1 なら結果は 1。両方が確実な 0 なら 0。それ以外は x
//   xor … 片方でも x なら x (0 でも 1 でも結果が変わるため)
//   mux … 選択が x でも、**両方の枝が同じ確実な値なら**結果は決まる
//
// 「確実な 0」は ~v & ~u、「確実な 1」は v & ~u。式の中の (v | u) や (~v | u) は
// その否定で、否定を 1 個ずつ減らすために展開した形になっている。

const M = (1n << 64n) - 1n;
const not = (a) => ~a & M;

/** 1 ネットぶんの 2 面。BigInt 64 ビット */
export const ZERO = { v: 0n, u: 0n };
export const ONE = { v: M, u: 0n };
export const UNKNOWN = { v: 0n, u: M };

export const constOf = (value) => (value === 'x' ? UNKNOWN : value ? ONE : ZERO);

/** 外に見せる値。x のビットは 0 として読める形に揃える */
export const known = (p) => p.v & not(p.u);

export const and2 = (a, b) => ({
  v: a.v & b.v,
  // どちらかが x で、かつ どちらも「確実な 0」でない
  u: (a.u | b.u) & (a.v | a.u) & (b.v | b.u),
});

export const or2 = (a, b) => ({
  v: a.v | b.v,
  // どちらかが x で、かつ どちらも「確実な 1」でない
  u: (a.u | b.u) & (not(a.v) | a.u) & (not(b.v) | b.u),
});

export const xor2 = (a, b) => ({ v: a.v ^ b.v, u: a.u | b.u });

export const notOf = (a) => ({ v: not(a.v), u: a.u });

export const muxOf = (s, a, b) => ({
  v: (s.v & a.v) | (not(s.v) & b.v),
  // 選択が決まっていれば選んだ側の不定がそのまま出る。
  // 選択が x のときは「両方の枝が同じ確実な値」でなければ x
  u: (not(s.u) & ((s.v & a.u) | (not(s.v) & b.u)))
    | (s.u & (a.u | b.u | (a.v ^ b.v))),
});

/**
 * 「この線は x か」を **0 か 1 の確実な値として**取り出す。
 *
 * 4 値の世界を外から覗く唯一の窓で、`===` / `!==` はこれ 1 個だけを足せば
 * 残りは普通のゲートで組める (elaborate の caseEqBits を参照)。
 * 不定の面をそのまま値の面に移し、結果の不定の面は必ず 0 になる。
 */
export const isxOf = (a) => ({ v: a.u, u: 0n });

const FOLD = { and: and2, or: or2, xor: xor2 };

/** ゲート 1 個。ins は入力の {v,u} の配列 */
export function evalGate(op, ins, value) {
  switch (op) {
    case 'const': return constOf(value);
    case 'buf': return ins[0];
    case 'not': return notOf(ins[0]);
    case 'isx': return isxOf(ins[0]);
    case 'and': case 'or': case 'xor': return ins.reduce(FOLD[op]);
    case 'mux': return muxOf(ins[0], ins[1], ins[2]);
    default: throw new Error(`4 値: 未知のゲート op '${op}'`);
  }
}
