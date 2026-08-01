// 非同期リセット付き 8bit カウンタ。
//
// リセットは「クロックを待たない」のが非同期の意味なので、rst を上げて eval() を
// 呼ぶだけで q が 0 になる (step() は不要):
//   sim.setInput('rst', 1).eval();   // → q = 0
//
// イベントリストの順番ではなく、**本体の先頭の if がどの信号を見ているか**で
// どちらが非同期リセットかが決まる。負論理なら negedge rst_n と if (!rst_n) で書く。
//
//   node tools/vwc.js examples/counter_rst.v --run 6 --set en=1
module counter_rst(
  input clk,
  input rst,
  input en,
  output reg [7:0] q
);
  always @(posedge clk or posedge rst)
    if (rst) q <= 8'h00;
    else if (en) q <= q + 1;    // en が 0 なら保持
endmodule
