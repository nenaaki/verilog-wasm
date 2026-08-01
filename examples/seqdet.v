// ビット列 "1011" を検出する Moore 型 FSM。case が状態遷移表になる。
//
// 状態: 00 = 何も見ていない / 01 = "1" / 10 = "10" / 11 = "101"
// found は既定値 0 を先に代入し、一致した経路だけが上書きする。この「既定値を
// 置いてから上書き」は if / case で保持ではなく毎サイクル決めたいときの定石。
//
// 検出には "1011" という並びが必要なので、CLI の定数入力では found は立たない
// (din=1 のままなら状態は 01 に張り付く。これは遷移表どおり)。列を流し込むには
// ブラウザデモで din をクロックごとに切り替える:
//   node tools/vwc.js examples/seqdet.v --run 4 --set din=1   … 01 に張り付くのを見る
//   node tools/serve.js                                      … din を手で振る
module seqdet(
  input clk,
  input din,
  output reg [1:0] state,
  output reg found
);
  always @(posedge clk) begin
    found <= 1'b0;

    case (state)
      2'b00: if (din) state <= 2'b01;                    // 0 なら 00 のまま
      2'b01: if (din) state <= 2'b01; else state <= 2'b10;
      2'b10: if (din) state <= 2'b11; else state <= 2'b00;
      2'b11: if (din) begin
               state <= 2'b01;                           // "1011" 一致。末尾の 1 が次の種になる
               found <= 1'b1;
             end else begin
               state <= 2'b10;
             end
    endcase
  end
endmodule
