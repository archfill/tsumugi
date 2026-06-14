# ADR-006: 管理 UI は運用卓として設計する

- 日付: 2026-06-14
- ステータス: Accepted

## コンテキスト

Phase 3 では tsumugi を独立サービスとして運用するため、管理 UI が必要になる。
この UI の主目的は、観測・記憶・決定・provenance・dreaming run を確認し、
必要な修正や手動実行を安全に行うことである。

tsumugi は記憶レイヤーであり、一般ユーザー向けのランディングページや
マーケティングサイトではない。管理 UI も、派手な可視化そのものより、
日常的な点検・比較・削除・archive・dreaming trigger を迷わず行えることを優先する。

## 決定

管理 UI は **「記憶レイヤーの運用卓」** として設計する。

### 視覚コンセプト

- 工業的な管理画面と、紙の台帳を合わせたトーンにする
- 背景には薄いグリッドを使い、記憶・provenance・編み目の構造を示唆する
- 左サイドバーは黒基調で固定し、運用対象の切り替えを常時見せる
- active state は黄色で強く示し、現在地を即座に判別できるようにする
- 赤系アクセントは delete / archive など注意が必要な操作に限定する
- 角丸は 6-8px 程度に抑え、柔らかすぎない管理ツールの印象を維持する

### 画面構造

Phase 3 の管理 UI は以下の 6 画面を基本単位とする。

| 画面          | 役割                                         |
| ------------- | -------------------------------------------- |
| Observations  | Layer 1 一覧、検索、状態確認、削除           |
| Memories      | Layer 2 一覧、検索、編集、archive            |
| Decisions     | decision の状態と supersede chain の確認     |
| Provenance    | observation / memory / decision の関係確認   |
| Dreaming runs | 実行履歴確認、dreaming job の手動 trigger    |
| Settings      | LLM tier、runtime endpoint、schedule の確認  |

### UX 原則

- 一覧から状態を読むことを最優先する
- 各画面の上部に検索を置き、データ量が増えても対象を絞れるようにする
- `type` / `source` / `time` / `promoted` / `status` などは本文より先に読める meta line と pill で表示する
- destructive action は確認を挟み、誤操作を防ぐ
- Memories の編集は一覧から modal で行い、画面遷移を増やさない
- Dreaming runs は job 選択、trigger、履歴確認に絞る
- Empty / loading / error state は画面ごとに明示する
- タブや検索条件は将来的に URL params と同期し、共有可能にする

## 代替案と却下理由

**マーケティング風ダッシュボード**

- 却下: tsumugi の管理 UI は運用者が繰り返し使う作業画面であり、
  大きな hero、装飾カード、抽象的な説明は操作密度を下げる。

**グラフ可視化中心 UI**

- 却下: provenance graph は重要だが、Phase 3 の主作業は一覧確認・編集・archive・trigger である。
  グラフを第一画面にすると、日常運用に必要な行単位の確認が遅くなる。
  Provenance 画面では段階的にグラフ表現を強化する。

**CLI / REST のみで運用**

- 却下: dreaming run、archive、decision chain、pending observation の状態を横断的に見るには、
  UI のほうが誤操作が少ない。CLI は自動化や緊急対応の補助として残す。

## 帰結

- 管理 UI は `apps/ui/` に置き、React + Vite + Tailwind を使う
- API 読み取りと mutation は TanStack Query を基本にする
- 画面状態は Query + URL params を基本とし、独自 global state は増やさない
- UI は shadcn 導入前でも成立するよう、標準 HTML control と CSS で実装可能にする
- destructive action は将来的に独自確認ダイアログへ置き換える
- Provenance は初期は edge list、将来的に graph visualization へ拡張する
- Settings は初期は読み取り中心、deploy 設定が固まった段階で編集可能にする
