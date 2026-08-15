// generate で作った段を階層参照でつなぐ。
//
// ラベル g がスコープになるので、i 段目の o は g[3].o という完全修飾名になる。
// これを式の中から読めるので、前の段の出力を次の段の入力にできる:
//
//   g[0]  d ──▶ leaf(K=1) ──▶ g[0].o
//   g[1]  g[0].o ──▶ leaf(K=2) ──▶ g[1].o
//   g[2]  g[1].o ──▶ leaf(K=2) ──▶ g[2].o
//   ...
//
// 添字は genvar なので、`g[i-1].o` は展開のたびに別の名前に落ちる。
// probe のように、インスタンスの中まで 2 段辿ることもできる。
//
//   node tools/vwc.js examples/chain4.v --top chain4 --run 1 --set d=9
module leaf #(parameter K = 1) (input [3:0] d, output [3:0] y);
  assign y = d ^ K;
endmodule

module chain4 #(parameter N = 4) (
  input  [3:0] d,
  output [3:0] chain,
  output [3:0] probe
);
  genvar i;
  generate
    for (i = 0; i < N; i = i + 1) begin : g
      wire [3:0] o;
      if (i == 0) leaf #(.K(1)) u (.d(d),        .y(g[0].o));
      else        leaf #(.K(2)) u (.d(g[i-1].o), .y(g[i].o));
    end
  endgenerate

  assign chain = g[N-1].o;      // 最後の段の出力
  assign probe = g[1].u.y;      // generate ブロックの中のインスタンスの中まで辿る
endmodule
