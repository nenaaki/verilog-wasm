// for の使いどころ。8 ビットのビット並べ替えと数え上げ。
//
// for は elaborate 時に完全展開する (合成ツールと同じ)。ループ変数は integer で
// 宣言し、実体は「elaborate 時の整数」= parameter と同じ扱いになる。だから本体の
// `q[i]` や `d[7-i]` は定数式の添字としてそのまま解ける。
//
// 展開なので手で書き並べたのと同じ回路になる。ビット反転は 8 ゲート = 配線だけ。
//
//   node tools/vwc.js examples/bitops8.v --run 4 --set d=0x35
module bitops8(
  input clk,
  input [7:0] d,
  output [7:0] rev,          // ビット順を反転
  output [3:0] ones,         // 立っているビットの数
  output [7:0] pfx,          // 下位から見た累積 OR (最初の 1 以降が全部 1)
  output reg [7:0] latched   // always の中でも for が使える
);
  integer i;

  function [7:0] reverse(input [7:0] v);
    integer k;
    begin
      reverse = 8'h00;
      for (k = 0; k < 8; k = k + 1)
        reverse[k] = v[7-k];
    end
  endfunction

  function [3:0] popcount(input [7:0] v);
    integer k;
    begin
      popcount = 4'd0;
      for (k = 0; k < 8; k = k + 1)
        popcount = popcount + {3'b000, v[k]};   // 加算器が 8 段に展開される
    end
  endfunction

  // 直前の結果を次の段が読む = ローカル変数を順に積む形。ブロッキング代入が要る所
  function [7:0] prefix_or(input [7:0] v);
    integer k;
    begin
      prefix_or[0] = v[0];
      for (k = 1; k < 8; k = k + 1)
        prefix_or[k] = prefix_or[k-1] | v[k];
    end
  endfunction

  assign rev  = reverse(d);
  assign ones = popcount(d);
  assign pfx  = prefix_or(d);

  always @(posedge clk)
    for (i = 0; i < 8; i = i + 1)
      latched[i] <= d[7-i];
endmodule
