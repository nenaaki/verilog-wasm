# verilog-wasm

Verilog サブセット（ゲート + レジスタ）を **WebAssembly バイナリに直接コンパイル**して、ブラウザ / Node で実行する。

外部ツールチェーンは使わない。LLVM も Binaryen も wat2wasm も不要で、WASM バイナリを JS で組み立てて `WebAssembly.instantiate` に渡している。依存パッケージはゼロ。

```bash
node test/run.js                                     # テスト
node tools/vwc.js examples/lfsr8.v --run 8 --set q=1 # 波形を出す
node tools/vwc.js examples/lfsr8.v --wat             # 生成コードを見る
node tools/bench.js                                  # スループット計測
node tools/serve.js                                  # → http://localhost:8080/web/
```

```text
$ node tools/vwc.js examples/shift8.v --run 8 --set din=1
shift8: nets=12 gates=2 regs=8 state=144B wasm=340B
 cyc | din |        q
-----+-----+---------
   0 |   1 | 00000000
   1 |   1 | 10000000
   2 |   1 | 11000000
   3 |   1 | 11100000
   ...
```

## パイプライン

```text
Verilog ソース
  ↓ lexer.js / parser.js
AST
  ↓ elaborate.js          … 全信号を 1 ビットのネットに展開 (bit-blast)
ネットリスト IR            … gates[] / regs[] / signals
  ↓ schedule.js           … トポロジカルソート・組合せループ検出
評価順に並んだゲート列
  ↓ layout.js             … 線形メモリのスロット割り当て
  ↓ codegen.js            … WASM バイナリ   (本番)
  ↓ wat.js                … WAT テキスト     (デバッグ用)
WebAssembly.instantiate → sim.js
```

**ネットリスト IR を中央に置いてフロントエンドとバックエンドを分離**している。フロントエンドを差し替えれば（GUI 回路エディタなど）バックエンドはそのまま使える。

| ファイル | 役割 | 行数 |
| --- | --- | --- |
| [src/lexer.js](src/lexer.js) | 字句解析 | 92 |
| [src/parser.js](src/parser.js) | 構文解析 → AST | 225 |
| [src/elaborate.js](src/elaborate.js) | AST → ネットリスト IR（bit-blast） | 267 |
| [src/schedule.js](src/schedule.js) | トポロジカルソート・ループ検出 | 52 |
| [src/layout.js](src/layout.js) | メモリレイアウト | 74 |
| [src/codegen.js](src/codegen.js) | WASM バイナリ生成 | 192 |
| [src/leb128.js](src/leb128.js) | LEB128・セクションエンコーダ | 59 |
| [src/wat.js](src/wat.js) | WAT 出力（デバッグ用バックエンド） | 77 |
| [src/interp.js](src/interp.js) | JS 参照実装（差分テスト用） | 73 |
| [src/sim.js](src/sim.js) / [src/signals.js](src/signals.js) / [src/compile.js](src/compile.js) | 実行時グルー・エントリ | 178 |
| **合計（コメント込み）** | | **1,296** |

## 対応している Verilog

```verilog
module reg_en(
  input clk,
  input en,
  input [3:0] d,
  output reg [3:0] q
);
  always @(posedge clk)
    q <= en ? d : q;      // ?: はマルチプレクサになる
endmodule
```

- `module` / `endmodule`、ANSI・非 ANSI 両方のポートリスト
- `input` / `output` / `wire` / `reg`、`[msb:lsb]` のベクタ
- `assign` による組合せ代入
- ゲートプリミティブ `and` `or` `not` `nand` `nor` `xor` `xnor` `buf`（多入力可）
- 式：`~` `&` `^` `|`、`? :`、ビット選択 `a[3]`、部分選択 `a[7:4]`、連接 `{a, b}`、`8'hFF` / `4'b1010` / `10` などのリテラル
- `always @(posedge clk)` + `<=`（ノンブロッキング代入）→ D フリップフロップ

**未対応**：算術 `+` `-`、比較、`if` / `case`、モジュール階層、非同期リセット、複数クロック、`x` / `z`。いずれも行番号付きのエラーになる。

幅の解決は Verilog 本来の文脈依存幅ではなく単純化した規則を使う。二項演算は両辺を `max(幅)` にゼロ拡張、代入は左辺の幅に切り詰め / ゼロ拡張。

## 生成されるコード

`node tools/vwc.js examples/full_adder.v --wat` の実際の出力（抜粋）:

```wat
(module
  (memory (export "memory") 1)
  ;; input    a @ 0
  ;; output   sum @ 24
  (func $eval (export "eval")
    (local $n2_a i64 $n3_b i64 $n4_cin i64 $n5_sum i64 ...)
    ;; --- 状態の読み込み ---
    (local.set $n2_a (i64.load offset=0 (i32.const 0)))
    ;; --- 組合せ論理 (トポロジカル順) ---
    (local.set $n10__and6 (i64.and (local.get $n2_a) (local.get $n3_b)))
    (local.set $n8__xor2  (i64.xor (local.get $n2_a) (local.get $n3_b)))
    ...
    ;; --- 出力ポート ---
    (i64.store offset=24 (i32.const 0) (local.get $n5_sum)))
  (func $commit (export "commit") ...)
  (func $step (export "step") (call $eval) (call $commit) (call $eval))
  (func $run (export "run") (param $n i32) ...))
```

論理回路のコンパイル結果は**分岐のない直線コード**なので、使う命令は `i64.and` / `i64.or` / `i64.xor` / `local.get` / `local.set` / `i64.load` / `i64.store` だけ。`run` のループにだけ `block` / `loop` / `br_if` / `call` / `i32.sub` / `i32.eqz` が加わる。面倒なのは LEB128 エンコーダだけで、そこは 59 行に収まっている。

内部の組合せ配線は **local に置いてメモリを経由しない**。メモリに出るのは入力・出力・レジスタの状態だけ。

## ビットスライス（64 レーン同時実行）

1 ネットを 1 ビットではなく **i64 の 64 ビット**に割り当てている。64 ビットそれぞれが独立したテストベクタの「レーン」で、`step()` 1 回で **64 パターンを同時にシミュレート**できる。

これが JS ではなく WASM で出す理由。JS で 64 ビット整数演算をやると `BigInt` しかなく、`i64.and` に対して桁違いに遅い。

```js
// 素朴に使う: setInput() は全 64 レーンに同じ値をブロードキャストする
sim.setInput('a', 1).setInput('b', 0);
sim.step();
console.log(sim.get('sum'));            // → 1n

// 並列スイープ: レーンごとに違う入力を入れて 1 回の step で全部評価
for (let lane = 0; lane < 64; lane++) {
  sim.setInputLane('a', lane, lane & 1);
  sim.setInputLane('b', lane, (lane >> 1) & 1);
}
sim.step();
sim.getLanes('sum');                    // → 64 個の結果
```

実測（`node tools/bench.js`、32bit LFSR × 8 = 298 ゲート / 256 レジスタ）:

```text
WASM  : 29 ms / 200,000 クロック = 6877 kclk/s
        2049 M gate-eval/s (1 レーン換算)
        131 G gate-eval/s   (64 レーン同時換算)
参照JS : 2130 ms 相当 → WASM は約 73 倍速
```

## 3 つの実行単位

| 関数 | 意味 |
| --- | --- |
| `eval()` | 組合せ論理だけを評価する。レジスタは変えない |
| `commit()` | 次状態 → Q の一括転送（= クロックエッジ） |
| `step()` | `eval` → `commit` → `eval` |
| `run(n)` | `eval` → (`commit` → `eval`) × n |

この分離には理由が 2 つある。

**1. 純粋な組合せ回路では `eval()` が本来の操作**。入力を変えた直後に「クロックは打たずに出力だけ落ち着かせる」ことができる。

**2. `step()` 末尾の `eval` は必須**。これがないと、クロックエッジ直後の組合せ出力が「エッジ前の状態から計算された値」のまま残る。`run(n)` はこの余分な `eval` を畳んで `n+1` 回の eval で `n` クロックを回す。

### レジスタの同時代入で踏みやすい罠

次状態のスロットは **D ネットごとではなくレジスタごとに専用で確保**している。これを D ネットで共有すると `a <= b; b <= a;` が壊れる。

`a` の D ネットは `b` の Q ネットそのものなので、スロットを共有すると `commit` が「a に旧 b を書く → b に *新しくなった* a を書く」という逐次代入になってしまう。レジスタごとに専用スロットを持たせると、この種のエイリアシングが構造的に起こり得なくなる。テストではスワップと 3 段ローテーションで固定してある。

## API

```js
import { compile } from './src/compile.js';
import { WasmSimulator } from './src/sim.js';

const compiled = compile(verilogSource);   // { bytes, wat, netlist, layout, stats, warnings }
const sim = await WasmSimulator.create(compiled);

sim.setInput('d', 0b1010);   // 入力ポート（reg も書けるので初期値のシードに使える）
sim.eval();                  // 組合せ論理のみ評価（クロックは打たない）
sim.step();                  // 1 クロック
sim.run(1000);               // 1000 クロック（ループは WASM 側にある）
sim.get('q');                // → BigInt
sim.getLanes('q');           // → 64 レーン分の BigInt[]
sim.reset();                 // 全状態をゼロクリア
sim.snapshot();              // 観測可能な全信号
```

`RefSimulator`（[src/interp.js](src/interp.js)）は同じ API を持つ JS 参照実装。

## テスト

中核は **WASM バックエンド vs JS 参照実装の差分テスト**。ランダムに生成した Verilog 25 回路 × ランダム入力 12 ベクタで、両者の出力が完全一致することを確認する。

コンパイラのバグは「症状が出た場所」と「原因」が遠いので、この比較対象があるかどうかで開発効率が変わる。加えて、全加算器の真理値表、DFF のタイミング、シフトレジスタ、LFSR の周期 255、レジスタのスワップと 3 段ローテーション、`eval` / `commit` の分離、64 レーンの独立性、9 種類のコンパイルエラーを検証している。

```text
$ node test/run.js
ok   全加算器
ok   ゲートプリミティブ
ok   DFF
ok   シフトレジスタ
ok   イネーブル付きレジスタ
ok   LFSR
ok   ビットスライス
ok   レジスタのスワップ
ok   eval / commit の分離
ok   エラー検出
ok   ランダム差分
ok   WAT 出力

423 件成功, 0 件失敗
```

## ブラウザデモ

`web/index.html` は ES モジュールを import するため `file://` では開けない（CORS でブロックされる）。

```bash
node tools/serve.js   # → http://localhost:8080/web/
```

Verilog を書いてコンパイルすると、生成された WAT・信号の波形・入力コントロールが出る。「1M クロック計測」ボタンでスループットも測れる。

## 次にやること

- `+` / `-`：桁上げ伝播加算器に bit-blast する（各 30 行程度）。これでカウンタが書ける
- `==` / `!=` / `<`：比較器の bit-blast
- `if` / `case`：AST 上でマルチプレクサ木に落とす
- 非同期リセット `always @(posedge clk or posedge rst)`
- モジュール階層（インスタンス化とポート接続の平坦化）
- 定数畳み込みと共通部分式除去（`$const0` / `$const1` 経由のゲートは大量に消せる）
