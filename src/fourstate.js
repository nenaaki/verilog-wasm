// 4 値 (0 / 1 / x / z) の符号化と、ゲート 1 個ぶんの計算式。
//
// **ここが唯一の仕様。** WASM を吐く codegen.js も、JS の参照実装 interp.js も、
// この式をそのままなぞる。2 つが食い違っていないことはランダム差分テストが見る。
//
// ---- 符号化 -----------------------------------------------------------------
//
// ネット 1 本を 3 枚の面で持つ。どれも 64 レーンぶんの i64:
//
//   v … 値の面
//   u … 不定の面 (1 なら x か z)
//   z … 高インピーダンスの面 (1 なら z)
//
//   0 = (v=0, u=0, z=0)   1 = (v=1, u=0, z=0)   x = (v=*, u=1, z=0)
//   z = (v=*, u=1, z=1)
//
// **u=1 のとき v は意味を持たない** (掃除しない)。掃除すると not のたびに
// 正規化が要るのに、u が立っていれば下流の式で必ず u が勝つので見なくて済む。
// 外に見せるときだけ `v & ~u` にして、x のビットは 0 として読める形に揃える。
//
// ---- なぜ z が u を含むか -----------------------------------------------------
//
// **`z=1` なら必ず `u=1`** にしてある。これが効くのは、Verilog が
// 「**式の中では z は x と同じ**」(`1'bz + 1` も `1'bz & 1` も x) と決めているため:
// z の面を見ない式 ―― 算術・比較・ビット演算 ―― は、何も直さないまま
// 自動的に正しい答えを出す。結果の z の面は 0 が既定で、これも正しい既定になる。
//
// z の面を計算するのは、**z を保たなければならない演算だけ**:
//
//   buf   … 接続 (assign / ポート) はそのまま通す
//   mux   … `?:` は選ばれた枝をそのまま通す
//   wire  … 多重ドライブの解決 (下の表)
//
// z の面を持たないネットは 3 枚目が最後まで 0 のままなので、codegen は
// そのネットの z の面のコードを出さない (WASM の local は 0 で始まる)。
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

/** 1 ネットぶんの 3 面。BigInt 64 ビット */
export const ZERO = { v: 0n, u: 0n, z: 0n };
export const ONE = { v: M, u: 0n, z: 0n };
export const UNKNOWN = { v: 0n, u: M, z: 0n };
export const HIZ = { v: 0n, u: M, z: M };

export const constOf = (value) => (
  value === 'z' ? HIZ : value === 'x' ? UNKNOWN : value ? ONE : ZERO);

/** 外に見せる値。x のビットは 0 として読める形に揃える */
export const known = (p) => p.v & not(p.u);

export const and2 = (a, b) => ({
  v: a.v & b.v,
  // どちらかが x で、かつ どちらも「確実な 0」でない
  u: (a.u | b.u) & (a.v | a.u) & (b.v | b.u),
  z: 0n,
});

export const or2 = (a, b) => ({
  v: a.v | b.v,
  // どちらかが x で、かつ どちらも「確実な 1」でない
  u: (a.u | b.u) & (not(a.v) | a.u) & (not(b.v) | b.u),
  z: 0n,
});

export const xor2 = (a, b) => ({ v: a.v ^ b.v, u: a.u | b.u, z: 0n });

export const notOf = (a) => ({ v: not(a.v), u: a.u, z: 0n });

export const muxOf = (s, a, b) => ({
  v: (s.v & a.v) | (not(s.v) & b.v),
  // 選択が決まっていれば選んだ側の不定がそのまま出る。
  // 選択が x のときは「両方の枝が同じ確実な値」でなければ x
  u: (not(s.u) & ((s.v & a.u) | (not(s.v) & b.u)))
    | (s.u & (a.u | b.u | (a.v ^ b.v))),
  // z も「選んだ枝をそのまま」。選択が決まらないときは両枝とも z のときだけ z
  // (`x ? 1'bz : 1'bz` は z。片方でも違えば x)
  z: (not(s.u) & ((s.v & a.z) | (not(s.v) & b.z))) | (s.u & a.z & b.z),
});

/**
 * 「この線は不定か」を **0 か 1 の確実な値として**取り出す。z も不定に数える。
 *
 * 4 値の世界を外から覗く唯一の窓で、`===` / `!==` はこれと isz を足せば
 * 残りは普通のゲートで組める (elaborate の bitMatch を参照)。
 * 不定の面をそのまま値の面に移し、結果の不定の面は必ず 0 になる。
 */
export const isxOf = (a) => ({ v: a.u, u: 0n, z: 0n });

/** 「この線は z か」。isx と対で `===` の x と z を見分ける */
export const iszOf = (a) => ({ v: a.z, u: 0n, z: 0n });

/**
 * z を x に落とす。**Verilog の `buf` / `bufif` の入力側**がこれで、
 * 「駆動していない線を受けたら不定」という規則を 1 個の演算にしてある
 * (`assign` の接続とは違って、プリミティブのゲートは z を通さない)。
 */
export const zxOf = (a) => ({ v: a.v, u: a.u, z: 0n });

/**
 * 多重ドライブの解決。1 本の wire を複数のドライバが叩いたときの値:
 *
 * |     | 0 | 1 | x | z |
 * | --- | - | - | - | - |
 * | **0** | 0 | x | x | 0 |
 * | **1** | x | 1 | x | 1 |
 * | **x** | x | x | x | x |
 * | **z** | 0 | 1 | x | z |
 *
 * 「**駆動していない (z) 側は無視し、残りが食い違えば x**」。全員が z なら z。
 * 3 本以上は 2 本ずつ畳む (この表は結合則を満たす)。
 */
export const wire2 = (a, b) => {
  const ax = a.u & not(a.z);          // a は x (z ではない不定)
  const bx = b.u & not(b.z);
  const both = not(a.z) & not(b.z);   // 2 本とも駆動している
  return {
    // 駆動している側の値。両方 z なら 0 だが、u が立つので意味を持たない
    v: (a.v & not(a.z)) | (b.v & not(b.z)),
    // x が混じる / 2 本とも駆動していて食い違う / 2 本とも z (結果も z)
    u: ax | bx | (both & (a.v ^ b.v)) | (a.z & b.z),
    z: a.z & b.z,
  };
};

const FOLD = { and: and2, or: or2, xor: xor2, wire: wire2 };

/** ゲート 1 個。ins は入力の {v,u,z} の配列 */
export function evalGate(op, ins, value) {
  switch (op) {
    case 'const': return constOf(value);
    case 'buf': return ins[0];
    case 'not': return notOf(ins[0]);
    case 'isx': return isxOf(ins[0]);
    case 'isz': return iszOf(ins[0]);
    case 'zx': return zxOf(ins[0]);
    case 'and': case 'or': case 'xor': case 'wire': return ins.reduce(FOLD[op]);
    case 'mux': return muxOf(ins[0], ins[1], ins[2]);
    default: throw new Error(`4 値: 未知のゲート op '${op}'`);
  }
}
