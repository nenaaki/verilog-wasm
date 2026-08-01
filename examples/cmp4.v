// 4bit マグニチュードコンパレータ (符号なし)。
// a >= b は a - b の桁上げ出力そのもので、残りは辺の入れ替えと反転で作る。
// 等価は差分ビットの OR リダクションなので、桁上げチェーンを通らず一番浅い。
//   node tools/vwc.js examples/cmp4.v --run 4 --set a=9 --set b=5
module cmp4(
  input  [3:0] a,
  input  [3:0] b,
  output lt,
  output eq,
  output gt
);
  assign lt = a <  b;
  assign eq = a == b;
  assign gt = a >  b;
endmodule
