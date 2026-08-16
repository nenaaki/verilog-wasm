// 4 ビットの signed。符号で結果が変わるのは 4 箇所しかない ―― 幅を広げるときの
// 符号拡張、比較、除算・剰余、`>>>` ―― ので、それを並べて符号なしと見比べる。
//
//   sext / zext … 同じ a を 8 ビットに代入するだけ。signed なら上位に符号が伸び、
//                 $unsigned() で読み直すとゼロ拡張になる
//   slt  / ult  … 片方でも符号なしが混じると、式全体が符号なしの比較になる
//   quot / rem  … Verilog の除算は floor ではなく 0 方向への切り捨て。
//                 剰余の符号は被除数に従う (-7 / 2 は -3 で、余りは -1)
//   asr  / lsr  … >>> は signed のときだけ符号ビットで埋める。符号なしなら >> と同じ
//
// mixed は「片方でも符号なしなら式全体が符号なし」の見本。a は signed だが、
// 符号なしの u と足すので、a もゼロ拡張されてから足される。
//
//   node tools/vwc.js examples/signed4.v --run 4 --set a=13 --set b=2 --set u=3
module signed4(
  input signed [3:0] a,
  input signed [3:0] b,
  input        [3:0] u,
  output signed [7:0] sext,
  output        [7:0] zext,
  output        [7:0] mixed,
  output lt,
  output ult,
  output signed [3:0] quot,
  output signed [3:0] rem,
  output signed [3:0] asr,
  output        [3:0] lsr,
  output signed [7:0] prod
);
  assign sext  = a;              // 符号拡張 (13 は -3 なので 8'hFD)
  assign zext  = $unsigned(a);   // ゼロ拡張 (8'h0D)
  assign mixed = a + u;          // u が符号なし → 両方ゼロ拡張して足す

  assign lt  = a < b;            // 符号付きの比較
  assign ult = a < u;            // 片方が符号なし → 符号なしの比較

  assign quot = a / b;
  assign rem  = a % b;

  assign asr = a >>> 1;          // 算術右シフト (符号が伸びる)
  assign lsr = u >>> 1;          // 符号なしなので >> と同じ

  assign prod = a * b;           // 8 ビット文脈なので符号拡張してから掛ける
endmodule
