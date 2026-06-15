# ADR-010: Phase 4 (yui 移行) の戦略

- 日付: 2026-06-15
- ステータス: Accepted

## コンテキスト

Phase 0〜3 を通じて tsumugi は独立サービスとして本番稼働した
(pve-docker + Traefik + TLS + Forgejo CI/CD)。

次の Phase 4 は「内部利用システム (yui) の memory 関連モジュールを
tsumugi 経由呼び出しに置換し、最終的に yui 側の memory 実装を撤去する」
段階。これは tsumugi プロジェクト最大の山場として README の roadmap
で位置付けられている。

設計判断の前提として、yui の利用実態と tsumugi の OSS 性質を整理した:

- **yui の active user は archfill 単独**。他に名目上のユーザは存在し得るが、
  実利用してる人間は archfill のみ。
- **tsumugi は public な OSS リポジトリ**。multi-tenant 対応を入れると
  以下のコストが発生する:
  - schema に `user_id` / `project_id` 列追加 (全 query 巻き込み)
  - filter API 拡張
  - auth / quota の境界引き直し
  - OSS 利用者にとって余計な複雑さ
- **mem0 / Plausible / Umami / n8n 等の同種 OSS** は「OSS は single-tenant、
  cloud 版で multi-tenant」が業界鉄板パターン。

eval bench で測った tsumugi と yui の挙動差:

- AUDN judge 判定一致率 **75%** (25% は edge case で意見が割れる)
- Search Recall@1 **0.885** (yui 実 narrative で実証済)
- Time-update 一致率 **100%** (絶対日付正規化で安定)

→ search / time-update は概ね問題なし、AUDN は実運用で当たって判断する
領域、という状態。

## 決定

### 1. multi-tenancy 戦略: シングルテナント維持

tsumugi の schema / API / コードに `user_id` / `project_id` を**入れない**。
OSS としては single-tenant のままにする。

将来 archfill が tsumugi を SaaS 化したくなった場合は、その時点で fork
または major refactor として multi-tenant 化する。OSS のメインライン
には混ぜない。

### 2. 移行方式: snapshot + 直 cutover

dual-write phase を設けず、以下の流れで一気に切替える:

1. yui DB の memory 関連テーブルを snapshot 保存
2. eval/seed-from-yui.ts を発展させたスクリプトで全データを tsumugi に
   API 経由で投入
3. yui の memory_service を tsumugi MCP client 呼出に置換 (interface は
   据え置き、yui の上位 layer に影響なし)
4. 切替後 1 週間程度日常使用しながら観察

archfill 単独運用かつ自身が利用者であるため、issue 発生時に当事者として
すぐ気付ける構造。dual-write 1〜2 週間を待つ価値より、当日 cutover で
本物の挙動差を掴む速度を優先する。

### 3. feature flag: 不要

「特定の user だけ tsumugi 経由」のような flag は archfill 単独運用
なら意味がない。yui 側コードを直接 tsumugi adapter に書き換える。

### 4. rollback: snapshot + yui コード 1 週間保持

- DB 戻し: 1 で取った snapshot をリストア
- コード戻し: yui の memory_service を git revert で旧実装に戻す
- 旧コードは 1 週間維持 (PR としては「削除」コミットを別途切る)
- 1 週間 archfill が日常使用して大きな issue が出なければ削除コミットを merge

### 5. スコープ確定

Phase 4 は archfill の memory データ移行 + yui 側 memory 実装撤去まで。

含まないもの:

- tsumugi の multi-tenant 化
- yui の他テーブル (users / projects / channels / agents / plans / tasks /
  team_insights / routing_decisions 等) は **そのまま残す**
- tsumugi schema 改変

含むもの:

- yui の `memories` / `observations` / `decisions` / `memory_history` を
  tsumugi schema にマッピングして投入
- yui memory_service の API を維持しながら内部実装を tsumugi MCP client 経由に
- yui の embedder / pgvector / audn / dreaming 等の memory 実装を削除
- yui DB の memory 系テーブルを drop (snapshot 保存後)

## 進行ステップ

| Step | 内容                                                              | 想定工数   |
| ---- | ----------------------------------------------------------------- | ---------- |
| 1    | このADR                                                           | 30 分      |
| 2    | yui の memory 層 API surface 調査、呼出箇所一覧化                 | 1-2 時間   |
| 3    | yui に Python MCP client を導入、tsumugi 疎通確認                 | 半日       |
| 4    | yui memory_service の adapter 実装 (interface 維持、内部実装置換) | 1-2 日     |
| 5    | データ移行スクリプト整備 (eval/seed-from-yui.ts を発展)           | 半日       |
| 6    | DB snapshot → 移行実行 → cutover                                  | 半日       |
| 7    | 1 週間観察                                                        | (経過待ち) |
| 8    | yui コード削除 + DB テーブル drop                                 | 半日       |

合計 **4-6 日**の実作業 + **1 週間**の安定観察期間。

## 検証

- archfill が日常で Claude Code / Codex から tsumugi 経由の memory 操作
  が滞りなく動くこと
- yui の他機能 (project 管理 / agent / plan / task) が影響を受けない
  こと
- 万一の rollback が手順通りに動作すること (cutover 前に dry-run)

## 帰結

### ポジ

- tsumugi OSS は single-tenant の単純さを保てる
- archfill の memory がより堅牢な tsumugi pipeline (3 層 resilience /
  dreaming scheduler / eval bench) に乗る
- yui のコードベースから memory 関連の重い実装 (embedder / dreaming /
  audn / synthesize / time-update 等) を撤去でき、yui は project / agent
  / plan / task の管理層に責務を集中できる
- yui の DB は memory 関連テーブル分軽くなる
- ADR-009 (eval を migration acceptance test に位置付ける) の数値根拠で
  「移行しても性能が維持される」ことが事前確認済

### ネガ

- dual-write を端折るため、移行直後に未知の挙動差で memory が壊れる
  可能性が残る (AUDN 25% 不一致が主リスク)
- 緩和策: snapshot ベース rollback + yui コード 1 週間保持
- yui に他 user が増える将来シナリオでは「yui-DB に戻す」or「tsumugi
  に multi-tenant 追加」or「user 別 tsumugi 立てる」のいずれかが必要に
  なる。今は決めない (YAGNI)

### 中立

- tsumugi MCP transport は WebStandardStreamableHTTPServerTransport で
  既に動いており、yui 側からは Python の `mcp` SDK で接続可能。新たな
  プロトコル設計は不要。

## 関連

- ADR-001 (Two-layer architecture)
- ADR-007 (LLM provider agnostic)
- ADR-008 (LLM resilience layers)
- ADR-009 (eval を yui → tsumugi 移行の acceptance test に位置付ける) ← 数値根拠の出処
- `apps/server/eval/`: 移行後の drift detection 用 bench
- `apps/server/eval/seed-from-yui.ts`: データ移行スクリプトの土台
- README `Phase 4` セクション
