# ADR-003: サーバー側 LLM ゼロ — クライアントへの意味判断委譲

- 日付: 2026-06-14
- 最終更新: 2026-07-26
- ステータス: Accepted
- 置換: 旧決定「hot path のみ LLM ゼロ」をサーバー全体へ拡張

## コンテキスト

MCP / REST の呼び出し元である Claude Code、Codex、yui は、すでに作業文脈を持つ
LLM を備えている。一方、tsumugi サーバーで capture / observation / memory を再要約・
再判定すると、外部 provider の rate limit、長い retry、部分成功後の再実行が発生した。
結果として保存済みデータの重複副作用と promotion 遅延が生じ、サーバー運用に API key、
provider fallback、cooldown、quarantine が必要になった。

Stop checkpoint の `continuity_content` はホスト側 LLM がすでに整理した最終応答である。
サーバーが同じ内容を再度 LLM で要約する必要はない。

## 決定

**tsumugi サーバーは、同期経路・scheduled job・手動 job のいずれからも外部 LLM を呼ばない。**

- `save_observation` はクライアントが渡した `content` / `type` / `facts` を検証し、そのまま保存する
- Stop capture は `continuity_content` を決定論的に 1 observation へ昇格する
- BGE-M3 embedding と pg_bigm / pgvector hybrid search はサーバー内で継続する
- observation を主要な検索対象とし、同じ source observation から派生した memory hit は重複表示しない
- memory は必須の自動生成層ではなく、既存互換または明示的に curated された任意層とする
- semantic merge、contradiction、supersede は自動適用せず、クライアントが文脈内で判断して明示操作する
- retention、outdated archive、exact duplicate 候補抽出など、意味内容を書き換えない保守だけを自動化する
- LLM API key、provider client、retry / fallback / cooldown / quarantine runtime はサーバー構成から除去する

旧 LLM job 名は既存クライアントとの互換性のため入力 schema に残せるが、実行時は DB や
provider に触れず `removed_server_llm` の no-op 結果を返す。

## 理由

- capture: deterministic hook と Stop checkpoint により取りこぼしを防げる
- recall: observation 自体を BGE-M3 + pg_bigm で検索できる
- forgetting: 時刻・状態・exact identity に基づく決定論的保守へ限定できる
- transparency: 保存元、時刻、provenance link を追跡できる
- continuity: promotion 待ち bridge と決定論的 Stop observation の両方を維持できる

## 代替案

### 別 provider またはローカル LLM へ置き換える

不採用。provider を変えても二重意味判断、部分成功、再試行増幅、運用秘密の問題は残る。

### embedding 類似度だけで memory を自動統合する

不採用。類似度は候補提示には使えるが、意味の同一性や contradiction の確定根拠にはならない。

### memory 層を即時削除する

不採用。既存の curated / legacy memory と provenance を保持し、observation-first 検索で段階移行する。

## 帰結

- サーバー起動・MCP / REST・scheduled maintenance に LLM API key は不要
- provider 障害で capture promotion が停止することはない
- サーバーが自動生成する fact 単位 memory は増えない
- 高度な意味整理は、元の作業文脈を持つクライアントの明示操作に委譲される
- 旧 LLM 生成データは hard delete せず、別の可逆監査手順で扱う

詳細な capture / observation / memory の状態遷移は ADR-014、検索契約は ADR-013 を参照する。
