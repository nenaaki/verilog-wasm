// generate で桁上げ伝播加算器を組む。全加算器 1 段を書いて、あとは for に並べさせる。
//
// generate は「どの項目を作るか」を elaborate 時に決める仕掛けで、always の中の
// for が「文」を展開するのに対し、こちらは wire 宣言・assign・インスタンスといった
// module の項目を展開する。だから段ごとの p / g を wire として持てる。
//
// ラベル bits がスコープになるので、i 段目の p は bits[3].p という完全修飾名になる。
// 段ごとの名前は生成コードにもそのまま残る (WAT では識別子として使えない文字が
// _ に置き換わって bits_3_.p になる)。W を変えれば段数がそのまま増える。
//
//   node tools/vwc.js examples/ripple8.v --run 4 --set a=200 --set b=100
//   node tools/vwc.js examples/ripple8.v --wat | grep bits_3_
module ripple8 #(parameter W = 8) (
  input  [W-1:0] a,
  input  [W-1:0] b,
  input          cin,
  output [W-1:0] sum,
  output         cout
);
  wire [W:0] c;                 // 段のあいだの桁上げ。c[0] が入力、c[W] が出力
  assign c[0] = cin;
  assign cout = c[W];

  genvar i;
  generate
    for (i = 0; i < W; i = i + 1) begin : bits
      wire p, g;                // 段ごとに 1 本ずつ持てるのが generate の効きどころ
      assign p = a[i] ^ b[i];   // 桁上げを通すか (propagate)
      assign g = a[i] & b[i];   // 桁上げを作るか (generate)
      assign sum[i] = p ^ c[i];
      assign c[i + 1] = g | (p & c[i]);
    end
  endgenerate
endmodule
