# ADR-001: 二層アーキテクチャ（Layer 1 / Layer 2）採用

- 日付: 2026-06-14
- ステータス: Accepted

## コンテキスト

AI エージェントの記憶管理において、「何を観測したか」と「何を覚えておくべきか」は本質的に異なる操作である。
観測データはリアルタイムに大量生成されるが、AI が参照すべき記憶は少量・高品質でなければならない。
両者を同一テーブル・同一フローで扱うと、書き込みの高速性と読み出しの精度がトレードオフになる。

また、synthesis（要約・統合）は LLM を要するため遅く高コストであり、observation の保存と同期的に行うべきではない。

## 決定

記憶を二層に分離する。

**Layer 1: observations**（生の観測、蓄積層）

- AI エージェントが `save_observation` で随時書き込む
- 内容は raw のまま保存、変換しない
- 高速書き込みを優先（hot path に LLM を置かない）
- 不変（immutable）: 書いたら変更しない

**Layer 2: memories**（合成済み記憶、参照層）

- observations から非同期に合成（dreaming フェーズ）
- narrative（物語形式）+ importance スコアで管理
- `archived_at` によるソフトデリートで忘却を表現
- 再生成可能（observations が正となるソース）

この設計により:

- hot path（save_observation）は LLM 不要でミリ秒単位
- synthesis は別プロセス/スケジューラで実行可能
- Layer 1 を保持すれば Layer 2 はいつでも再構築できる

## 代替案と却下理由

**単一テーブル案（observations のみ）**

- 採用しなかった理由: 観測が増えるほど検索精度が低下する。重要情報が埋もれる。

**mem0 / Supermemory などの既製品**

- 採用しなかった理由: tsumugi は AI エージェントの作業記憶に特化したシステムであり、
  汎用記憶 SaaS ではなく archfill のツールチェーンに最適化した制御が必要。
  依存追加より自前実装のほうが設計意図が明確になる。

**リアルタイム synthesis（observation 保存と同期）**

- 採用しなかった理由: BGE-M3 の推論でも数百ミリ秒かかる。LLM synthesis は数秒単位。
  MCP tool call の応答時間として許容できない。

## 帰結

- `observations` テーブルと `memories` テーブルの二つが schema の中心になる
- `links` テーブルで Layer 1 → Layer 2 の provenance を記録できる
- dreaming（synthesis）フェーズは Phase 2 以降で実装する（現在は Layer 1 のみ稼働）
- hot path で LLM を呼ばない原則は ADR-003 と連動する
