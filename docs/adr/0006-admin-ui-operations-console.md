# ADR-006: 管理 UI は運用卓として設計する

- 日付: 2026-06-14
- 最終更新: 2026-07-13
- ステータス: Accepted
- 影響 ADR: ADR-013 (provenance / outdated), ADR-014 (Three-layer architecture)

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

ADR-014 反映後の管理 UI は以下の 4 画面を基本単位とする。Capture を単独 tab として
追加するのではなく、Capture → Observation → Memory の流れ全体を運用単位にする。

| 画面       | 役割                                                                 |
| ---------- | -------------------------------------------------------------------- |
| Overview   | Capture / Observation / Memory の件数、state、滞留、queue を俯瞰    |
| Pipeline   | capture / window / observation / fact / provenance を trace 単位で追跡 |
| Memories   | Memory と Decision の検索、状態確認、既存 edit / archive           |
| Operations | scheduler、dreaming runs、deferred / quarantine / stale / outdated |

Provenance は独立した edge ID 一覧ではなく Pipeline detail に統合する。Decision は Memories
内の副 view、Dreaming runs と Settings は Operations に統合する。

### Read-only API contract

既存 integration の REST contract は維持し、Admin UI 専用の集計 / trace API を
`/api/admin/*` に分離する。

| Endpoint                                | 役割                                      |
| --------------------------------------- | ----------------------------------------- |
| `GET /api/admin/filter-options`         | project / source / view 別 state 候補     |
| `GET /api/admin/overview`               | Three-layer 集計、queue、attention、schedule |
| `GET /api/admin/pipeline/traces`        | cursor pagination 付き trace 一覧         |
| `GET /api/admin/pipeline/traces/:id`    | trace の node / provenance edge           |
| `GET /api/admin/operations/issues`      | 要 review 項目の統合 read model           |

既存 `GET /api/memories` には、default response を変えずに project / source / state / 期間 /
query filter を追加する。Memory の project / source は自身の列ではなく observation provenance
経由で判定する。

初回改訂では retry / unquarantine / mark outdated の mutation は追加しない。既存 Memory edit /
archive のみ維持し、raw capture は detail 内の bounded preview とする。

### UX 原則

- 一覧から状態を読むことを最優先する
- 各画面の上部に project / source / state / 期間 / query filter を置き、server-side で絞る
- `type` / `source` / `time` / `promoted` / `status` などは本文より先に読める meta line と pill で表示する
- destructive action は確認を挟み、誤操作を防ぐ
- Memories の編集は一覧から modal で行い、画面遷移を増やさない
- Overview は marketing dashboard にせず、工程の状態と要対応件数を高密度に読む画面にする
- Pipeline は一覧 + detail の master-detail とし、graph を主画面にしない
- Operations は job / run / issue の状態確認を優先し、新 mutation は監査契約確定後に追加する
- Empty / loading / error state は画面ごとに明示する
- view と検索条件は URL params と同期し、再現可能にする

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
- 既存 REST endpoint は初回改訂で削除しない。新 UI 安定後に access log を確認し、
  `GET /links` と `DELETE /observations/:id` の deprecation を別作業として判断する
