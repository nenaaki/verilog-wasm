// イネーブル・同期クリア付き 8bit アップカウンタ。
// q + 1 は桁上げ伝播加算器に bit-blast される (加算器 1 段 = xor 2 個 + and 2 個 + or 1 個)。
//   node tools/vwc.js examples/counter8.v --run 8 --set en=1
module counter8(
  input clk,
  input en,
  input clr,
  output reg [7:0] q
);
  always @(posedge clk)
    q <= clr ? 8'h00 : (en ? q + 1 : q);
endmodule
