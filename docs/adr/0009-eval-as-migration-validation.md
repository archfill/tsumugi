# ADR-009: 評価ベンチを yui → tsumugi 移行の acceptance test として利用する

- 日付: 2026-06-15
- ステータス: Accepted

## コンテキスト

tsumugi は当初、内製プラットフォーム yui の memory レイヤを将来的に置き換える
ことが想定されていた (Phase 4 移行)。それまでの間、tsumugi 単体のコア品質を
測る目的で `apps/server/eval/` に評価ベンチ基盤を整備し、合成 fixture (132 件)
と yui 本番 DB から自動抽出した private fixture (634 件) で各 dreaming ジョブと
hybrid search を回せるようにした。

private fixture 整備の過程で次が判明した:

- yui 本番 DB から **既存 memory / observation / decision を tsumugi の bench
  入力形式に変換するロジック (`eval/seed-from-yui.ts`)** が既に揃っている。
  これは移行スクリプトの土台になる。
- yui 実 narrative での Search bench は **Recall@1 0.885 / Recall@5 1.000**、
  Time-update bench は **avgCosine 0.950** と高水準。移行後も検索体験が劣化
  しない数値根拠が出た。
- yui の AUDN 判定と tsumugi の AUDN 判定の一致率は **decisionAccuracy 0.751**。
  これは「両実装の意見が edge case で 25% 食い違う」という inter-implementation
  drift の定量化であり、移行時のリスク評価に直接使える。
- Promote bench の ground truth は「yui で memory に linked か」では粗すぎる
  ことも露見した。これ自体が、移行前に**ラベリング設計を見直すべき**という
  メタ情報になっている。

つまり評価ベンチは、tsumugi 単体の品質測定にとどまらず、**yui → tsumugi
移行の客観的な acceptance test** として高い価値を持つ。

## 決定

評価ベンチ基盤を、tsumugi 単体品質の測定に加えて **yui → tsumugi 移行の
受け入れ基準** として正式に位置付ける。

### Acceptance criteria 素案

移行 GA を切る判定材料として下記を採用する (閾値は今後の改善で見直し可)。

| 指標                                             | 閾値   | 現状値 | 状態      |
| ------------------------------------------------ | ------ | ------ | --------- |
| Search Recall@1 (private)                        | ≥ 0.85 | 0.885  | ✅        |
| Search Recall@5 (private)                        | ≥ 0.95 | 1.000  | ✅        |
| Time-update avgCosine (synthetic+private)        | ≥ 0.85 | 0.950  | ✅        |
| AUDN decisionAccuracy (yui データに対する一致率) | ≥ 0.70 | 0.751  | ⚠️ 余裕薄 |
| AUDN passRate (synthetic only)                   | ≥ 0.85 | 0.913  | ✅        |
| Promote passRate (synthetic only)                | ≥ 0.90 | 0.967  | ✅        |
| Contradiction passRate (synthetic)               | ≥ 0.90 | 0.967  | ✅        |
| Resilience unit tests                            | 100%   | 100%   | ✅        |

private fixture の AUDN/Promote スコア (それぞれ 73% / 55%) は **ラベリング
の粗さに起因する歪み** が支配的で、絶対的な品質指標とは見なさない。改善は
別タスクで扱う。

### 運用形態

- 日常品質: `mise run -C apps/server bench` を CI で nightly 実行 (Layer 1
  retry の挙動を含めて drift detection)。
- 移行リハーサル: 移行直前に `eval/seed-from-yui.ts` で fixture を再抽出し、
  bench を回して全 acceptance criteria を満たすか確認する。
- 失敗時の挙動: criteria を割った場合は移行延期。改善 PR を別途投入。

### `seed-from-yui.ts` の二次利用

スクリプトは内部に raw SQL での yui 本番 schema 抽出ロジックを持つ
(`memory_history.action` から AUDN UPDATE/DELETE、`observations.payload->>narrative`
等)。これは将来の移行ツールが流用できる。eval ディレクトリ専有とせず、
schema 変換ロジックは適宜 `tools/migration/` 等に切り出す可能性を残す。

## 検証

- 2026-06-15 時点で yui データを通した bench を実行し、表の現状値を取得。
  全 5 bench (AUDN/Promote/Search/Contradiction/Time-update) + resilience
  vitest が完走することを確認。
- 8 件の LLM error (Z.ai 429 rate limit) は Layer 1 retry で吸収しきれず
  発生したが、本番運用想定の負荷では発生しない burst (bench 専用) のため
  実害なし。

## 帰結

- **ポジ**: 移行時の意思決定が定量化される。「tsumugi で yui を代替できる」
  という主張に数値根拠がつく。bench を回すだけで現在地が分かる。
- **ポジ**: drift detection が同じ枠組みでできる。Prompt や model を変えた
  ときの影響範囲が見える。
- **ポジ**: 合成 fixture と private fixture の二系統を用意することで、
  「実装の正しさ (synthetic)」と「実分布での挙動 (private)」を分離評価できる。
- **ネガ**: yui 本番 DB へのアクセスが必要なため、private bench は CI で
  自動実行しづらい (1Password / Tailscale 経由の手動オペが必要)。Public CI
  では synthetic のみ。
- **ネガ**: yui の bench ラベルは時間と共に古くなる。fixture 再抽出を月次
  などで定期化する運用が必要。

## 関連

- ADR-001 (Two-layer architecture): 評価対象の Layer 1/2 を定義
- ADR-002 (Hybrid search): Search bench の評価対象
- ADR-007 (LLM provider agnostic): bench は provider 非依存に動く
- ADR-008 (LLM resilience layers): Resilience bench で各 layer を検証
- `apps/server/eval/HANDOFF.md`: bench 基盤の利用方法と設計パターン
