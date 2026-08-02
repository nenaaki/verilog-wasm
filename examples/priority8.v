// 8 入力の優先順位エンコーダ。casez の代表的な使いどころ。
//
// ラベルに書いた ? (= z) は「その桁を比較しない」印なので、`8'b1???_????` は
// 「最上位が 1 なら、下位が何であっても一致」になる。上から順に見て最初に
// 一致したものが勝つので、そのまま優先順位になる。
//
// 同じ表を case で書くと 255 個のラベルを並べることになる。
//
//   node tools/vwc.js examples/priority8.v --run 8 --set req=0x24
module priority8(
  input clk,
  input [7:0] req,
  output reg [2:0] sel,     // 立っている中で最上位のビット番号
  output reg       any      // どれか 1 本でも立っているか
);
  always @(posedge clk) begin
    casez (req)
      8'b1???_????: sel <= 3'd7;
      8'b01??_????: sel <= 3'd6;
      8'b001?_????: sel <= 3'd5;
      8'b0001_????: sel <= 3'd4;
      8'b0000_1???: sel <= 3'd3;
      8'b0000_01??: sel <= 3'd2;
      8'b0000_001?: sel <= 3'd1;
      8'b0000_0001: sel <= 3'd0;
      default:      sel <= 3'd0;
    endcase
    any <= |req;
  end
endmodule
