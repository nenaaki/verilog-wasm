// parameter とパラメータ付きインスタンス化。
//
// 同じ counter を幅も刻みも変えて 3 個並べる。階層の平坦化のときにインスタンスごとの
// スコープでパラメータを評価するので、`[WIDTH-1:0]` が各インスタンスで別の幅になる。
//
// 差し替えは名前指定 (.WIDTH(4)) と順番指定 (#(4, 3)) の両方が書ける。
// localparam は「値を導くだけ」の定数で、外から差し替えられない。
//
//   node tools/vwc.js examples/counter_param.v --run 6
//   node tools/vwc.js examples/counter_param.v --top counter --run 4   ← 既定の 8 ビットで単体を見る
module counter #(
  parameter WIDTH = 8,
  parameter STEP  = 1
) (
  input clk,
  input rst,
  output [WIDTH-1:0] q
);
  localparam TOP = WIDTH - 1;

  reg [TOP:0] cnt;

  always @(posedge clk or posedge rst)
    if (rst) cnt <= 0;
    else cnt <= cnt + STEP;

  assign q = cnt;
endmodule

module counter_param(
  input clk,
  input rst,
  output [3:0] small,
  output [7:0] big,
  output [3:0] by3
);
  counter #(.WIDTH(4)) c0(clk, rst, small);   // 4 ビット、1 刻み
  counter c1(clk, rst, big);                  // 既定のまま 8 ビット
  counter #(4, 3) c2(clk, rst, by3);          // 順番指定: WIDTH=4, STEP=3
endmodule
