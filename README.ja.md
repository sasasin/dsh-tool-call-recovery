# dsh-tool-call-recovery

DSH の PTC セッションで、モデルが `<tool_call><function=read>...` を通常の本文に出して作業を終えてしまう場合に、形式の修正と正式なツール呼び出しを促すプラグイン。

本文をコードとして実行せず、`agent/turn-stopping` で `agent.steer(...)` を使い、モデルに追加のステップを生成させる。実際の呼び出しは通常の DSH の検証・承認・実行を通る。ループ本体の変更や Strata の `undeclared_tool_calls: call` は不要。

[English](README.md) · [MIT ライセンス](LICENSE)

## インストール

`<profile>` を利用するプロファイル名（例: `web`）へ置き換えてください。

```sh
dsh plugin --profile <profile> add github:sasasin/dsh-tool-call-recovery
```

公開版を固定する場合:

```sh
dsh plugin --profile <profile> add github:sasasin/dsh-tool-call-recovery#v1.0.0
```

インストール後に DSH を再起動します。bundle として自動登録されます。このプラグインの追加だけでは PTC の選択や UI の追加は行いません。

対応する DSH は `>=0.2.2-rc.1 <0.3.0-0`、Node.js は `^22.19.0 || >=24.0.0`。実測は DSH `0.2.2-rc.1` です。実行時依存パッケージやビルド処理はなく、インストール時のビルド許可も不要です。

## 動作

1. ターン終了直前に、最新の確定した assistant 応答を読む。
2. 末尾に独立した XML 呼び出しが残っていれば、未実行であることと、PTC の `run_code` 経由の呼び方を通知する。
3. モデルが正式な呼び出しを生成し、作業を続ける。
4. 正常なツール実行がないまま修正できない場合は、既定で連続2回まで再試行し、その後は未完了のエラーで終了する。
5. 正常なツール結果を受け取ったら連続回数をリセットする。長い作業で別の誤出力が発生しても、修正に成功していれば再試行できる。ターン全体の補正には別の上限（既定20回）を設ける。

通知は独自の source `tool-call-recovery`、`form: notice` を持つ `user/message` としてセッションに残る。元の assistant 本文は変更しない。連続回数とターン通算回数は通知とツール結果から復元でき、プラグインの再読み込みで上限がリセットされることを防ぐ。旧版の通知も読める。

初回公開版 v1.0.0 には、正常なツール結果による連続回数リセットと、ターン全体の上限を含みます。

## 設定

`$DSH_HOME/profiles/<profile>/cordis.patch.yml` で必要な項目だけ上書きできます。`DSH_HOME` 未指定時は `$HOME/.dsh/profiles/<profile>/cordis.patch.yml` です。設定は起動・再読み込み時に検証する。

```yaml
- id: tool-call-recovery
  config:
    enabled: true
    ptcOnly: true
    maxRetries: 2
    maxRecoveriesPerTurn: 20
    maxTextChars: 65536
```

| 項目 | 既定値 | 意味 |
|---|---|---|
| enabled | true | 有効・無効 |
| ptcOnly | true | 公開ツールが `run_code` のみの場合に限定 |
| maxRetries | 2 | 正常なツール実行を挟まない連続再試行の上限。0〜10。0 は検知時に直ちに未完了のエラー |
| maxRecoveriesPerTurn | 20 | ターン全体の補正回数の上限。1〜1000。無関係な成功を繰り返す場合の無制限な再試行を防ぐ |
| maxTextChars | 65536 | 検知する本文の最大文字数。1024〜1048576 |

未知の設定項目や範囲外の値はエラーにする。無効化するには `enabled: false` を指定する。

## 検知範囲と限界

- `<tool_call>` の中に `<function=名前>` と閉じた `</function>` がある、末尾の独立したブロックを検知する。外側の `</tool_call>` の欠落は許容する。
- コードフェンス、インラインコード、Markdown の引用・字下げコード、例と明示された直前のラベル、呼び出し後に説明が続くものを除外する。
- 推論の本文は読まない。JSON だけの呼び出しや、引数・関数タグ自体が途中で切れた出力は対象外。
- **最新の応答に正式な tool-call が混在する場合は再試行しない。** 実行済みの副作用を繰り返すことを避けるための限定。後続の最新応答が XML 本文のみになった場合は検知する。
- 本文の意図の識別は完全ではない。これは狭い検知に基づく修正の促しであり、一般的な文章から任意の操作を実行するものではない。
- 自己修正するかはモデルにも依存する。再試行上限を超えた場合に成功扱いで終了しないことを重視する。

## 検証

```sh
git clone https://github.com/sasasin/dsh-tool-call-recovery.git
cd dsh-tool-call-recovery
npm ci
npm test
npm run test:dsh
```

`test:dsh` はローカル試験用 API と隔離した DSH_HOME を使い、本物の DSH のループ・PTC executor・read を検証する。ネットワーク用ソケットと DSH の子プロセスを起動できる環境が必要。既存の会話は操作しない。

2026-11-11 の確認結果:

- 単体テスト14件: 検知、引用除外、重複通知防止、連続上限と通算上限、正常な実行による連続回数リセット、旧履歴からの回数復元、中断など。
- DSH 統合テスト7条件: 無効時の再現、有効時の復旧、コード例の除外、連続失敗の上限、3件の独立した誤出力の復旧、通算上限、ツール実行が失敗した場合に連続回数をリセットしないこと。
- 実際の Strata + Qwen + DSH: 最初の XML 本文 → 補正通知1回 → `run_code` → 内部の `read` → 試験ファイルと完全一致する回答。

実モデルの試験は短い読み取り課題。加えて、実際に停止した30ステップの会話ログを再生し、旧版が止まった3件目でも改修版が補正を出せることを確認した。自然な長い実作業全体の完遂率を測ったものではない。

統合テストの結果は、リポジトリー内の Git 管理対象外の `test-results/integration/` に保存します。モデルや実 API キーは不要です。

補正通知とエラー文は現在、日本語です。自己修正できるかはモデルの指示追従にも依存します。

## アンインストール

```sh
dsh plugin --profile <profile> remove dsh-tool-call-recovery
```

プロファイルに追加した専用の上書き設定も取り除き、DSH を再起動してください。

## ライセンス

[MIT](LICENSE)。
