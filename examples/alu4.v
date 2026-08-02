// 4 ビット ALU。case で演算を選ぶ。
//
// case の書き方をひととおり使っている:
//   - 1 項目に複数ラベル (3'd5, 3'd6)
//   - default (ここに来るのは 3'd7 だけ)
//   - 既定値を先に置いてから条件で上書きする形 (eq)
// 単項マイナス (-a) と中置の XNOR (a ~^ b) もここで使う。
//
//   node tools/vwc.js examples/alu4.v --run 8 --set a=9 --set b=5 --set op=1
module alu4(
  input clk,
  input [2:0] op,
  input [3:0] a,
  input [3:0] b,
  output reg [3:0] y,
  output reg eq
);
  always @(posedge clk) begin
    eq <= (a == b);

    case (op)
      3'd0: y <= a + b;
      3'd1: y <= a - b;
      3'd2: y <= a & b;
      3'd3: y <= a | b;
      3'd4: y <= -a;              // 2 の補数。4 ビットなので -1 は F
      3'd5, 3'd6: y <= a ~^ b;    // どちらのラベルでもビットごとの XNOR
      default: y <= 4'h0;         // 残るのは 3'd7
    endcase
  end
endmodule
