// while / repeat。どちらも elaborate 時に完全展開するので、回路としては
// 手で書き並べたのと同じものになる（ゲートは 1 個も増えない）。
//
// for との違いは添字を進める場所だけ:
//   for   … ヘッダで進める   for (i = 0; i < 8; i = i + 1)
//   while … 本体で進める     i = 0; while (i < 8) begin … i = i + 1; end
//
// `i = i + 1` の `=` は integer への代入で、これは展開時の値なので回路にならない。
// レジスタへの代入は always @(posedge …) の中では今までどおり `<=` である。
//
// repeat は回数が定数に決まるぶん、添字を持たずに書ける。ここでは組合せ側で
// ブロッキング代入を積み上げるのに使っている（ones の数え上げ）。
//
//   node tools/vwc.js examples/loops8.v --run 2 --set d=181
module loops8(
  input  clk,
  input  [7:0] d,
  output reg [7:0] rev,      // ビット順を逆にする
  output reg [7:0] even,     // 偶数ビットだけ通す
  output reg [3:0] ones      // 1 の個数 (組合せ)
);
  integer i;
  integer k;

  always @(posedge clk) begin
    i = 0;
    while (i < 8) begin
      rev[i] <= d[7-i];
      i = i + 1;
    end

    // 添字は減らす向きにも動かせる。刻みも 1 でなくてよい
    even <= 8'h00;
    i = 6;
    while (i >= 0) begin
      even[i] <= d[i];
      i = i - 2;
    end
  end

  // 組合せ側。repeat は回数だけ決めて、添字は自分で進める
  always @(*) begin
    ones = 4'h0;
    k = 0;
    repeat (8) begin
      ones = ones + d[k];    // ブロッキングなので前の行の結果を読める
      k = k + 1;
    end
  end
endmodule
