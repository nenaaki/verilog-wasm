// リダクション演算子。全ビットを 1 個のゲート列に畳んで 1 ビットにする。
//
//   &d   全ビットの AND        (全部 1 か)
//   |d   全ビットの OR         (どれか 1 か)
//   ^d   全ビットの XOR        (1 の個数が奇数か = パリティ)
//   ~&d  ~|d  ~^d              それぞれの反転 (NAND / NOR / XNOR)
//
// `~&d` は `~` と `&` に割れても「1 ビットの結果を反転」になるので同じ意味になる。
// `^~` と `~^` だけは 1 トークンとして扱う (幅が偶数のとき ^(~d) と結果が違う)。
//
//   node tools/vwc.js examples/parity8.v --run 1 --set d=139
module parity8(
  input [7:0] d,
  output odd,
  output even,
  output allOnes,
  output anyOne,
  output [8:0] withParity
);
  assign odd     = ^d;
  assign even    = ~^d;
  assign allOnes = &d;
  assign anyOne  = |d;

  // 奇数パリティを先頭に付けて 9 ビットにする (連接の中でも使える)
  assign withParity = {^d, d};
endmodule
