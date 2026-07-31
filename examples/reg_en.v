// ロードイネーブル付き 4bit レジスタ (?: がマルチプレクサになる)
module reg_en(
  input clk,
  input en,
  input [3:0] d,
  output reg [3:0] q
);
  always @(posedge clk)
    q <= en ? d : q;
endmodule
