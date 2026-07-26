# ADR-009: 評価ベンチを yui → tsumugi 移行の acceptance test として利用する

- 日付: 2026-06-15
- 最終更新: 2026-07-27
- ステータス: Accepted

## コンテキスト

tsumugiがyuiのmemoryレイヤを置き換えるには、API疎通だけでなく、検索品質、移行完全性、
provenance、rollbackを一貫して確認する必要がある。評価ベンチとmigration fixtureを、
単体品質の測定だけでなくyui cutoverの客観的なacceptance testとして利用する。

2026-07-26にADR-003 / ADR-014でserver-side LLMを撤去したため、AUDN、Promote、
Contradiction、Time-update、provider resilienceの旧bench結果は現行GA gateから外す。

## 決定

評価ベンチをyui移行のacceptance testとして維持し、現行契約では以下を評価する。

| 評価軸 | Acceptance criteria |
| --- | --- |
| Search relevance | synthetic queryのRecall@k / MRRがbaseline以上、または差分を説明できる |
| Migration integrity | 対象件数、ID、主要field、provenance linkがmanifestと一致する |
| Observation-first recall | Layer 2 observationを検索でき、直接派生したLayer 3 memoryの重複hitだけを抑制する |
| Legacy compatibility | standalone / unlinked / curated memoryを引き続き検索できる |
| Reversibility | plan / apply / restoreを同じ対象件数で再現し、restore後の状態がbaselineと一致する |
| Privacy | raw private contentをCI log、fixture、Issue artifactへ出さない |

旧semantic jobのスコアを満たすためにserver-side LLM処理を復活させてはならない。

## 運用

- Public CIではin-processのprovenance policy synthetic、architecture contract、unit / integration testを実行する
- DB / embeddingを使う`bench:search`はcutover前に認可済み環境で明示実行し、Recall@k / MRRをbaselineと比較する
- private fixtureはprivate network内の明示実行に限定し、raw contentを成果物へ出さない
- cutover前はsnapshot、migration manifest、search比較、rollback dry-runを揃える
- criteriaを満たさない場合はcutoverを延期し、原因と許容可否を別途判断する
- 実装状況と次の優先順位は[`../ROADMAP.md`](../ROADMAP.md)だけで管理する

## Historical snapshot (2026-06-15)

server-side LLM撤去前は、合成fixture 132件とprivate fixture 634件を使い、
Search、AUDN、Promote、Contradiction、Time-update、resilienceを評価していた。

- Search: Recall@1 0.885 / Recall@5 1.000
- Time-update: avgCosine 0.950
- AUDN: decisionAccuracy 0.751
- synthetic passRate: AUDN 0.913 / Promote 0.967 / Contradiction 0.967

これらは当時の設計変更を比較するhistorical evidenceであり、現在のjob構成やGA gateを
定義しない。旧provider、retry、quarantine、semantic promotionの復活根拠にも使わない。

## 帰結

- yui cutoverの可否を検索・移行・rollbackの実測で判断できる
- syntheticとprivateの評価境界を分離し、public CIへprivate dataを持ち込まずに済む
- LLM prompt / provider品質ではなく、現行のdeterministic contractを継続評価できる
- private fixtureのラベルは時間とともに古くなるため、利用時に再抽出と妥当性確認が必要

## 関連

- ADR-002 (Hybrid search)
- ADR-003 (server-wide zero LLM / client delegation)
- ADR-010 (yui migration)
- ADR-014 (Three-layer / observation-first recall)
- `apps/server/eval/`
