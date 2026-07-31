// 8bit 右シフトレジスタ。din が上位ビットから入る
module shift8(
  input clk,
  input din,
  output reg [7:0] q
);
  always @(posedge clk)
    q <= {din, q[7:1]};
endmodule
