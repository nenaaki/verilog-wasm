// 組合せ ALU。always @(*) で書く。
//
// always @(posedge clk) との違いは 2 つ:
//   代入が `=` (ブロッキング)。後の文は前の文の結果を読むので、途中結果を
//   一時変数に置いて積み上げられる (flags がそれ)
//   保持が無い。どの経路でも代入されないビットがあるとラッチになるので、
//   この処理系はそれを作らずにエラーにする → 先に既定値を置くのが定石
//
// [examples/alu4.v](alu4.v) は同じ演算をレジスタ出力で書いたもの。
// あちらは 1 クロック待つが、こちらは eval() 1 回で答えが出る。
//
//   node tools/vwc.js examples/alu_comb.v --run 1 --set a=9 --set b=5 --set op=1
module alu_comb(
  input  [2:0] op,
  input  [3:0] a,
  input  [3:0] b,
  output reg [3:0] y,
  output reg zero,
  output reg carry
);
  reg [4:0] wide;             // 桁上げまで受ける途中結果 (内部なので観測はできない)

  always @(*) begin
    // まず既定値。これを置かないと、case で拾わない op でラッチになる
    wide = 5'd0;
    case (op)
      3'd0: wide = a + b;
      3'd1: wide = a - b;
      3'd2: wide = {1'b0, a & b};
      3'd3: wide = {1'b0, a | b};
      3'd4: wide = {1'b0, a ^ b};
      3'd5: wide = {1'b0, ~a};
      3'd6: wide = a < b ? 5'd1 : 5'd0;
      default: wide = 5'd0;   // 残るのは 3'd7
    endcase

    // ブロッキングなので、ここでは上で決まった wide が読める
    y     = wide[3:0];
    carry = wide[4];
    zero  = (wide[3:0] == 4'h0);
  end
endmodule
