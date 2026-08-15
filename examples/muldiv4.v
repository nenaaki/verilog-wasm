// 4 ビットの乗除算。* は部分積を積む配列乗算器、/ と % は筆算そのままの
// 復元法になる。どちらも組合せ回路なので、1 クロックではなく 1 eval で答えが出る。
//
// 幅の見どころ:
//   prod は 8 ビットなので 15 * 15 = 225 まで入る (文脈幅が 8 に広がる)
//   wrap は 4 ビットなので上位が落ちる — Verilog の意味論そのまま
//   half は定数 2 での除算。定数畳み込みでただのシフトになり、回路は残らない
//
// b が 0 のとき quot は全ビット 1、rem は a のままになる。Verilog は x を返すが、
// この処理系は x を値として持たないので、回路が出す値をそのまま仕様にしている。
//
//   node tools/vwc.js examples/muldiv4.v --run 4 --set a=13 --set b=5
module muldiv4(
  input  [3:0] a,
  input  [3:0] b,
  output [7:0] prod,
  output [3:0] wrap,
  output [3:0] quot,
  output [3:0] rem,
  output [3:0] half
);
  assign prod = a * b;
  assign wrap = a * b;
  assign quot = a / b;
  assign rem  = a % b;
  assign half = a / 2;
endmodule
