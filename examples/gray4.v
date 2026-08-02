// function の使いどころ。4 ビットのグレイコード変換器。
//
// function は呼び出しごとにインライン展開される。中身は Verilog の仕様上時間制御を
// 持てないので必ず組合せ回路で、ローカル変数は「その場で値が入る一時変数」になる
// (だから代入は = で、レジスタのノンブロッキング <= とは違う)。
//
// 同じ引数で何度呼んでも共通部分式除去で 1 個に畳まれるので、式を直接書いた場合と
// ゲート数は完全に一致する。
//
//   node tools/vwc.js examples/gray4.v --run 16 --set clk=1
module gray4(
  input clk,
  input [3:0] bin,
  output [3:0] gray,        // 2 進 → グレイ
  output [3:0] back,        // グレイ → 2 進 (往復して元に戻る)
  output       adjacent,    // 隣り合う値のグレイコードが 1 ビットだけ違うか
  output reg [3:0] counted  // グレイコードで数えるカウンタ
);
  // 2 進 → グレイ: 自分と 1 つ上のビットの XOR
  function [3:0] to_gray(input [3:0] b);
    to_gray = b ^ (b >> 1);
  endfunction

  // グレイ → 2 進: 上位からの累積 XOR。ローカル変数に順に積む
  function [3:0] from_gray(input [3:0] g);
    reg [3:0] acc;
    begin
      acc[3] = g[3];
      acc[2] = acc[3] ^ g[2];
      acc[1] = acc[2] ^ g[1];
      acc[0] = acc[1] ^ g[0];
      from_gray = acc;
    end
  endfunction

  // 立っているビットの数がちょうど 1 か
  function one_hot(input [3:0] v);
    begin
      case (v)
        4'b0001, 4'b0010, 4'b0100, 4'b1000: one_hot = 1'b1;
        default:                            one_hot = 1'b0;
      endcase
    end
  endfunction

  assign gray = to_gray(bin);
  assign back = from_gray(to_gray(bin));          // 入れ子の呼び出し
  assign adjacent = one_hot(to_gray(bin) ^ to_gray(bin + 4'd1));

  always @(posedge clk)
    counted <= to_gray(from_gray(counted) + 4'd1);
endmodule
