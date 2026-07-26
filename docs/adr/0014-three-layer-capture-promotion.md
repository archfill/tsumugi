# ADR-014: Three-layer 化 — deterministic Stop promotion と observation-first recall

- 日付: 2026-06-17
- 最終更新: 2026-07-26
- ステータス: Accepted
- 影響 ADR: ADR-001、ADR-003、ADR-011、ADR-013

## コンテキスト

agent の自主的な `save_observation` だけでは、重要な completed turn が保存されない場合がある。
そこで raw hook event を TTL 付き capture として隔離し、検索可能な observation へ昇格する
Three-layer 構成を導入した。

初期実装では capture を LLM で window 要約し、observation を fact に分解して memory へ
LLM 昇格していた。しかし provider rate limit、長時間 retry、部分成功後の再実行が発生し、
同じ source から薄い memory が複数生成される副作用も確認された。Stop payload にはホスト側
LLM が整理した `continuity_content` が含まれるため、サーバー側の再要約は不要である。

## 決定

### Three-layer architecture

| Layer | 名前 | 主な source | lifetime | 既定検索 |
| --- | --- | --- | --- | --- |
| 1 | capture | hook event | TTL 30日 | 非公開 |
| 2 | observation | client save / Stop promotion | 永続 | 対象 |
| 3 | memory | legacy / 明示 curated | 永続 | 対象 |

Layer 2 の observation を canonical source とする。Layer 3 memory は必須の自動生成先ではない。

### capture

- `UserPromptSubmit`、`Stop`、限定 milestone、compact 境界を deterministic に保存する
- hook の同期経路は capture insert のみで、promotion や外部 LLM を待たない
- `turn_id` と event、content hash により再送を冪等化する
- SessionStart は未昇格 Stop の sanitized `continuity_content` だけを bounded inject できる
- raw capture と promotion input は retention sweep で期限切れ削除する

### Stop checkpoint promotion

scheduled `promote-captures` は active な未昇格 Stop checkpoint を処理する。

1. Stop 1件につき `continuity_content.trim()` を 1 observation として保存する
2. facts は生成せず `null`、type は `other`、source layer は `capture` とする
3. BGE-M3 embedding を生成する
4. observation、capture link、capture / window 完了状態を同一 transaction で確定する

promotion key は versioned であり、turn がある場合は source / session / turn、ない場合は
content hash を含む。同じ checkpoint の再送・再実行で observation を重複生成しない。

Stop 以外の legacy LLM window は自動昇格しない。専用 CLI の dry-run で分類し、明示 apply
時だけ、再構成可能な Stop を deterministic queue へ戻す。その他は理由付きで retire する。

### observation-first recall

- observation と memory を従来どおり hybrid search する
- RRF 後、候補 observation から直接 `derived_from` された候補 memory だけを抑制する
- standalone / unlinked / curated memory、候補外 observation 由来 memory は維持する
- provenance、source、project、timestamp、outdated 状態を結果へ付与する
- similarity は順位付け・review candidate に使い、semantic content の自動更新根拠にしない

### deterministic maintenance

scheduler が自動実行してよい job は以下に限定する。

- `promote-captures`: Stop checkpoint の決定論的 observation 化
- `sweep-captures`: TTL と terminal state に基づく raw capture 清掃
- `archive-outdated`: 明示的に outdated とされた memory の soft archive

旧 `promote-observations`、`synthesize`、`time-update`、`decision-contradiction`、`reflection` は
互換入力として受理しても、副作用のない `removed_server_llm` no-op とする。retry 操作も
deterministic Stop window だけを対象とし、旧 fact / observation retry は no-op とする。

## 移行

- historical promotion / LLM failure 列は既存 DB 互換と監査のため直ちには drop しない
- server provider client、LLM config、API key、fallback / cooldown runtime は削除する
- 旧 LLM 生成 memory は一括削除せず、source observation を保護した可逆 archive で扱う
- direct `save_observation` は保存時点で promotion completed とし、fact queue を作らない

## 不変条件

- サーバーから外部 LLM outbound call を行わない
- automatic job は semantic content を書き換えない
- hard delete 前提のデータ改善を行わない
- raw private content を CI log、fixture、Issue artifact へ出さない
- production mutation は dry-run、backup、対象件数、restore 検証後に別途承認を得る

## 検証

- unit: 冪等性、noise guard、legacy no-op、search suppression、run record
- integration: disposable PostgreSQL で migration、atomic commit、retry、MCP / REST save-search
- evaluation: synthetic query で before / after の Recall@k、MRR、結果件数を比較
- operations: staging clone で dry-run / apply / restore と DB・index・latency を比較

## 帰結

- capture / continuity は保持したまま、provider 障害と retry 増幅を除去できる
- 新規の thin auto-generated memory は増えない
- 既存 memory は互換検索でき、同じ observation の重複 hit だけを抑制できる
- 意味整理の責務は、元の文脈を持つクライアントへ戻る
