// ランダムな Verilog 回路を組み立てる。テストランナー (test/run.js) と
// 本物のシミュレータとの差分テスト (test/verilog-diff.js) の両方が使う。
//
// **何を突き合わせるかを人が列挙している間は、列挙から漏れたものが残る。**
// ここが出す構文の幅がそのまま両方のテストの網の広さになる。

export function makeRng(seed) {
  let s = seed | 0;
  return () => {
    s ^= s << 13; s |= 0;
    s ^= s >>> 17;
    s ^= s << 5; s |= 0;
    return ((s >>> 0) % 1000000) / 1000000;
  };
}

/**
 * @param opts.xstate 4 値のときだけ出せるもの (x を混ぜたリテラル) を許すか。
 *   **`===` はこれが要点**で、`isx` は codegen と fourstate.js に実装が 2 つある。
 *   手で書いたテストだけでなく、ここの網でも掛かるようにしておく。
 */
export function randomDesign(rng, nWires, opts = {}) {
  const pick = (arr) => arr[Math.floor(rng() * arr.length)];
  // プールは { n: 名前, w: 幅 }。幅を持ち歩くのは添字を範囲内に収めるため
  const pool = [{ n: 'a', w: 8 }, { n: 'b', w: 8 }, { n: 'c', w: 8 }];
  const lines = [];
  let inSub = false;         // 子モジュールの本体を組み立てている間だけ true
  let dcKind = rng() < 0.5 ? 0 : 1;   // casez / casex を交互に出すための番号

  /** x を混ぜた 8 ビットのリテラル (4 値のときだけ) */
  const xLit = () => `8'b${[...Array(8)]
    .map(() => (rng() < 0.35 ? 'x' : String(Math.floor(rng() * 2)))).join('')}`;

  const expr = (depth) => {
    const r = rng();
    if (depth <= 0 || r < 0.25) {
      const s = pick(pool);
      const k = rng();
      // **幅はプールが持っている。** 添字を幅の外に出すとコンパイルエラーになるし、
      // 幅の混ざった式こそ Verilog の「自己決定幅 / 文脈幅」を突ける所なので、
      // 信号ごとの幅を追いかける (実際に幅の文脈のバグがここから出た)
      if (k < 0.2) return `${s.n}[${Math.floor(rng() * s.w)}]`;
      if (k < 0.35) {
        const hi = Math.floor(rng() * s.w);
        const lo = Math.floor(rng() * (hi + 1));
        return `${s.n}[${hi}:${lo}]`;
      }
      if (k < 0.42) return `8'h${Math.floor(rng() * 256).toString(16)}`;
      // 幅の違うリテラルも混ぜる (文脈幅の配られ方が変わる)
      if (k < 0.47) { const w = 1 + Math.floor(rng() * 12); return `${w}'d${Math.floor(rng() * 4)}`; }
      if (k < 0.5) return `1'b${Math.floor(rng() * 2)}`;
      // x を値として書いたリテラル (4 値のときだけ)
      if (opts.xstate && k < 0.56) return xLit();
      return s.n;
    }
    if (r < 0.37) return `(~${expr(depth - 1)})`;
    if (r < 0.4) {
      // 乗除算。回路が他より一桁大きいので、右辺は葉に留めて深追いしない。
      // **2 値と本物を比べるときは除数が 0 にならないようにする** ―― 0 除算は
      // 2 値では「回路が出す値」(全ビット 1)、Verilog では x で、意図して違う
      // (4 値では揃うので、そのときは 0 も通す)
      const md = ['*', '/', '%'][Math.floor(rng() * 3)];
      const rhs = expr(0);
      const safe = md !== '*' && opts.avoidDivZero ? `(${rhs} | 8'h1)` : rhs;
      return `(${expr(depth - 1)} ${md} ${safe})`;
    }
    if (r < 0.52) return `(${expr(depth - 1)} & ${expr(depth - 1)})`;
    if (r < 0.62) return `(${expr(depth - 1)} | ${expr(depth - 1)})`;
    if (r < 0.72) return `(${expr(depth - 1)} ^ ${expr(depth - 1)})`;
    if (r < 0.75) {
      const lg = ['&&', '||'][Math.floor(rng() * 2)];
      return `(${expr(depth - 1)} ${lg} ${expr(depth - 1)})`;
    }
    if (r < 0.77) return `(!${expr(depth - 1)})`;
    if (r < 0.8) {
      // リダクション。~& / ~| / ~^ も混ぜる
      const red = ['&', '|', '^', '~&', '~|', '~^'][Math.floor(rng() * 6)];
      return `(${red}${expr(depth - 1)})`;
    }
    if (r < 0.82) return `(${expr(depth - 1)} + ${expr(depth - 1)})`;
    if (r < 0.85) return `(${expr(depth - 1)} - ${expr(depth - 1)})`;
    if (r < 0.87) return `(-${expr(depth - 1)})`;
    if (r < 0.9) {
      // === / !== も混ぜる。2 値では == / != と同じ答えになるが、4 値では
      // isx を通る別の回路になる (実装が 2 つある部品なのでここに乗せたい)
      const cmp = ['==', '!=', '<', '<=', '>', '>=', '===', '!=='][Math.floor(rng() * 8)];
      return `(${expr(depth - 1)} ${cmp} ${expr(depth - 1)})`;
    }
    if (r < 0.94) {
      // リテラル量 (並べ替え) と信号量 (バレルシフタ) の両方を出す。
      // 算術シフトも混ぜる (signed が絡まなければ >> と同じ答えになるはず)
      const op = pick(['<<', '>>', '<<<', '>>>']);
      const amt = rng() < 0.5 ? String(Math.floor(rng() * 10)) : expr(0);
      return `(${expr(depth - 1)} ${op} ${amt})`;
    }
    if (r < 0.96) return `(${expr(depth - 1)} ? ${expr(depth - 1)} : ${expr(depth - 1)})`;
    // 生成した function をインライン展開に通す。中身は if / case / ローカル変数入り。
    // 子モジュールには宣言していないので、そちらを組み立てている間は出さない
    if (r < 0.98 && !inSub) return `rndf(${expr(depth - 1)}, ${expr(depth - 1)})`;
    // 繰り返し連接も混ぜる。回数は 1〜4 の定数
    if (rng() < 0.35) return `{${1 + Math.floor(rng() * 4)}{${expr(depth - 1)}}}`;
    return `{${expr(depth - 1)}, ${expr(depth - 1)}}`;
  };

  // 式から呼べる function を 1 本置く。ローカル変数・部分代入・if / case を
  // まとめて通したいので、中身は少し込み入った形にしてある
  lines.push(`  function [7:0] rndf(input [7:0] p, input [7:0] q);
    reg [7:0] t;
    integer k;
    begin
      t = p ^ q;
      if (t[0]) t[7:4] = q[3:0];
      // for の展開も差分テストに通す (ビット並べ替え + 累積)
      for (k = 0; k < 4; k = k + 1)
        t[k] = t[k] ^ p[7-k];
      case (t[2:1])
        2'd0: rndf = t + p;
        2'd1: rndf = t - q;
        2'd2: rndf = {t[3:0], q[7:4]};
        default: rndf = t;
      endcase
    end
  endfunction`);

  // generate で 1 ビットずつ組み立てる wire を 1 本。展開された項目がふつうの
  // assign とまったく同じ経路を通ることを差分テストに通す。入力だけから作るので
  // プールに入れても組合せループにはならない。
  const gop = pick(['^', '&', '|']);
  lines.push('  genvar gi;');
  lines.push('  wire [7:0] wg;');
  lines.push('  for (gi = 0; gi < 8; gi = gi + 1) begin : gblk');
  lines.push('    wire t;');
  lines.push(`    assign t = a[gi] ${gop} b[7-gi];`);
  // if-generate で偶数ビットと奇数ビットの作り方を変える (枝の選択も差分に通す)
  lines.push('    if (gi % 2 == 0) begin : ev');
  lines.push('      assign wg[gi] = c[gi] ? t : ~t;');
  lines.push('    end else begin : od');
  lines.push('      assign wg[gi] = t & c[gi];');
  lines.push('    end');
  lines.push('  end');
  pool.push({ n: 'wg', w: 8 });

  // 組合せ always を 1 本。ブロッキング代入と「既定値 → 分岐で上書き」を差分に通す。
  // 読むのは入力だけなので、pool に入れても組合せループにはならない
  const cop = pick(['&', '|', '^']);
  lines.unshift('  reg [7:0] rc, rct;');
  lines.push('  always @(*) begin');
  lines.push(`    rct = a ${cop} b;`);
  lines.push('    rc = rct ^ c;');            // 1 行上の結果を読む (ブロッキング)
  lines.push('    if (c[0]) rc = rct;');       // 既定値を置いてあるのでラッチにならない
  lines.push("    else if (c[1]) rc[3:0] = 4'hF;");
  lines.push('  end');
  lines.push('  assign rout5 = rc;');
  pool.push({ n: 'rc', w: 8 });

  // signed の wire を 1 本プールに入れる。これが式に混ざると符号拡張・符号付きの
  // 比較・除算・算術右シフトの経路に入る (混ざらない式は符号なしのまま)
  lines.push(`  wire signed [7:0] ws = ${expr(2)};`);
  pool.push({ n: 'ws', w: 8 });

  // **パラメータで幅が決まる module を、違う幅で 3 回インスタンス化する。**
  // ここが Verilog で一番込み入った 2 つ ―― 幅の規則と parameter ―― の交差点で、
  // しかも「同じ module を別の幅で展開する」経路でもある
  // (幅のキャッシュがインスタンスをまたぐと静かに壊れる所)。
  //
  // 中身は幅に効く形を集めてある: `[W-1:0]` の宣言、`2*W-1` の定数式、
  // パラメータ境界の部分選択、`{W{…}}` の繰り返し連接、桁上げが 1 ビット残る加算、
  // そしてリダクションを広い文脈に置く形。
  //
  // **プールに入れるのは早いうちに。** 後ろに置くと、式が組み上がった後になって
  // ほとんど使われない (実際に 20 回路のうち 4 回路にしか届いていなかった)。
  const widths = [1, 2, 3, 5, 8].sort(() => rng() - 0.5).slice(0, 3);
  widths.forEach((w, i) => {
    lines.push(`  wire [${w - 1}:0] pw${i};`);
    lines.push(`  rndw #(.W(${w})) pw${i}_u(.p(${pick(pool).n}), .q(${pick(pool).n}), .r(pw${i}));`);
    pool.push({ n: `pw${i}`, w });
  });

  // **幅の違う wire をプールに入れる。** ここまでは全部 8 ビットで、幅が揃っていると
  // Verilog で一番込み入った所 ―― 自己決定幅と文脈幅の規則 ―― がほとんど動かない。
  // 狭いものと広いものを混ぜると、式のたびに切り詰めと拡張が起きる。
  // 1 ビットは「リダクションやビット選択の結果を広い文脈に置く」形を作りやすい
  for (const w of [1, 3, 5, 12]) {
    lines.push(`  wire [${w - 1}:0] n${w} = ${expr(2)};`);
    pool.push({ n: `n${w}`, w });
  }

  for (let i = 0; i < nWires; i++) {
    // 半分は宣言と同時に代入する (assign に分けたのと同じ回路になるはず)
    if (rng() < 0.5) lines.push(`  wire [7:0] w${i} = ${expr(3)};`);
    else { lines.push(`  wire [7:0] w${i};`); lines.push(`  assign w${i} = ${expr(3)};`); }
    pool.push({ n: `w${i}`, w: 8 });
  }

  // レジスタ (状態) も混ぜる。r は pool に入れて組合せ側からも参照させる
  lines.unshift('  reg [7:0] r;');
  pool.push({ n: 'r', w: 8 });
  const regExpr = expr(3);
  lines.push(`  always @(posedge clk) r <= ${regExpr};`);

  // 分岐のある always ブロックも 1 本入れる。mux 木がコード生成まで通るか見る。
  // 分岐の中身は begin...end で囲んで、dangling else を生まないようにする。
  lines.unshift('  reg [7:0] r2;');
  lines.unshift('  integer li;');   // while の添字
  const stmt = (depth) => {
    const r = rng();
    if (depth <= 0 || r < 0.4) return `r2 <= ${expr(2)};`;
    // repeat と while も混ぜる。while は添字を本体で進める形にしないと終わらない
    if (r < 0.44) return `repeat (${1 + Math.floor(rng() * 3)}) begin ${stmt(depth - 1)} end`;
    if (r < 0.48) {
      // 呼び出し側が begin … end で囲むので、2 文並べて返してよい
      const n = 1 + Math.floor(rng() * 3);
      return `li = 0; while (li < ${n}) begin ${stmt(depth - 1)} li = li + 1; end`;
    }
    if (r < 0.7) {
      const then = `begin ${stmt(depth - 1)} end`;
      const els = rng() < 0.5 ? ` else begin ${stmt(depth - 1)} end` : '';
      return `if (${expr(2)}) ${then}${els}`;
    }
    // 半分は casez / casex にして、ラベルの一部を don't care にする。
    // casex は x も比較から外すので、同じ表を別の書き方で出せる。
    // **どちらにするかは交互**にする ―― 毎回コインを投げると、don't care の case
    // 自体が数個しか出ない回では片方が 1 度も現れないことがある (実際に起きた)
    if (rng() < 0.5) {
      const kind = dcKind++ % 2 === 0 ? 'casez' : 'casex';
      const dc = kind === 'casez' ? '?' : 'x';
      const arms = [`2'b0${dc}: begin ${stmt(depth - 1)} end`,
        `2'b1${dc}: begin ${stmt(depth - 1)} end`];
      if (rng() < 0.5) arms.push(`default: begin ${stmt(depth - 1)} end`);
      return `${kind} (${expr(1)}) ${arms.join(' ')} endcase`;
    }
    const arms = [`2'd0: begin ${stmt(depth - 1)} end`, `2'd1: begin ${stmt(depth - 1)} end`];
    if (rng() < 0.7) arms.push(`default: begin ${stmt(depth - 1)} end`);
    return `case (${expr(1)}) ${arms.join(' ')} endcase`;
  };
  lines.push(`  always @(posedge clk) begin ${stmt(3)} end`);
  lines.push(`  assign rout2 = r2;`);

  // 非同期リセット付きのレジスタも 1 本。eval で Q を書き戻す経路が WASM と
  // 参照実装で別実装なので、ここを差分テストに通したい。
  lines.unshift('  reg [7:0] r3;');
  lines.push(`  always @(posedge clk or posedge rst)`);
  // **リセット値は定数にする。** 実際の RTL がそう書くというだけでなく、式にすると
  // この処理系と Verilog のモデルの差が出る ―― Verilog の非同期リセットは rst の
  // **エッジ**で発火するが、こちらは「rst が真のあいだ Q を上書きする」レベル方式
  // なので (README「クロックを待たない、を cycle-based でどう表すか」)、
  // **リセットを保持したまま値が変わる**式だと答えが割れる。
  lines.push(`    if (rst) r3 <= 8'h${Math.floor(rng() * 256).toString(16).padStart(2, '0')};`);
  lines.push(`    else r3 <= ${expr(2)};`);
  lines.push(`  assign rout3 = r3;`);
  lines.push(`  assign rout4 = subOut ^ subOut2;`);

  // **2 値と本物を突き合わせるときは、レジスタに初期値を与える。**
  // 2 値には x が無いので `initial` の無いレジスタは 0 から始まるが、Verilog は
  // x から始まる。しかも `r <= r ^ …` のように自分を読むレジスタだと x が消えないので、
  // クロックを空打ちしても揃わない。両方を同じ所から始めるには初期値が要る。
  if (opts.seedRegs) {
    for (const name of ['r', 'r2', 'r3']) {
      lines.push(`  initial ${name} = 8'h${Math.floor(rng() * 256).toString(16).padStart(2, '0')};`);
    }
  }

  // 部品を 1 個インスタンス化する。境界をまたぐ buf と平坦化を差分テストに通す。
  // 子の中身は自分のポートだけで書く必要があるので、プールを一時的に差し替える
  const parentPool = [...pool];
  pool.length = 0;
  pool.push({ n: 'p', w: 8 }, { n: 'q', w: 8 });
  inSub = true;
  const subBody = expr(2);
  inSub = false;
  pool.length = 0;
  pool.push(...parentPool);

  // パラメータ付きで 2 回インスタンス化して、同じ module が別の幅で展開されるのを見る
  const shiftBy = 1 + Math.floor(rng() * 4);
  lines.push(`  wire [7:0] subOut, subOut2;`);
  lines.push(`  rndsub s0(.p(${pick(pool).n}), .q(${pick(pool).n}), .r(subOut));`);
  lines.push(`  rndsub #(.SH(${shiftBy})) s1(.p(${pick(pool).n}), .q(${pick(pool).n}), .r(subOut2));`);
  pool.push({ n: 'subOut', w: 8 }, { n: 'subOut2', w: 8 });

  lines.push(`  assign y = ${expr(3)};`);

  return `module rndsub #(parameter SH = 0) (input [7:0] p, input [7:0] q, output [7:0] r);
  localparam SH2 = SH + SH;
  assign r = (${subBody}) << SH2;
endmodule

// 幅がまるごとパラメータで決まる module。**同じものを違う W で何度も展開する**ので、
// 幅の解決がインスタンスごとに独立していないと静かに壊れる
module rndw #(parameter W = 4) (input [W-1:0] p, input [W-1:0] q, output [W-1:0] r);
  localparam TOP = W - 1;
  wire [W-1:0]   x1 = p ^ q;
  wire [W:0]     x2 = p + q;          // 1 ビット広いので桁上げが残る
  wire           x3 = ^x1;            // リダクション → 1 ビット
  wire [2*W-1:0] x4 = {p, q};         // 連接 (幅は 2W)
  wire [W-1:0]   x5 = {W{x3}};        // 繰り返し連接の回数がパラメータ
  assign r = x3 ? x2[TOP:0] : (x4[W-1:0] | x5);
endmodule

module rnd(
  input clk,
  input rst,
  input [7:0] a,
  input [7:0] b,
  input [7:0] c,
  output [7:0] y,
  output [7:0] rout,
  output [7:0] rout2,
  output [7:0] rout3,
  output [7:0] rout4,
  output [7:0] rout5
);
${lines.join('\n')}
  assign rout = r;
endmodule`;
}

