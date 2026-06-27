# 2026-06-28: ADR-014 実装前の Codex save_observation 漏れ事例

## 概要

ADR-014 実装前の Codex session で、private dotfiles repository の NixOS
package 追加作業を完了したにもかかわらず、agent が `save_observation` を
自発的に呼ばなかった。

作業は rebuild、commit、push まで完了しており、後続 session で再利用可能な
`progress` observation として保存されるべき内容だった。ユーザーが保存有無を
確認した後、agent が手動で `save_observation` を実行した。

この事象は、ADR-014 の deterministic capture 層が実運用で同種の漏れを回収できるか
検証するための pre-implementation incident として扱う。ここに書く内容は追加対策の
決定ではなく、Phase 6 の検証観点である。

## 事実

- 発生時点: ADR-014 の capture 層実装前
- 対象: private dotfiles repository
- 作業内容:
  - NixOS system package を追加
  - rebuild を実行し、system 反映を確認
  - commit を作成
  - remote branch へ push
- 漏れたタイミング:
  - rebuild 成功後の final response
  - commit/push 成功後の final response
- 回復経路:
  - ユーザーが保存有無を確認
  - agent がその後に `save_observation` を手動実行

## 観測された failure mode

今回の漏れは「保存対象かどうか不明だった」ためではない。作業内容は以下の基準で
`progress` として保存対象だった。

- repository に durable な設定変更を反映した
- rebuild / verification が成功した
- commit / push により durable な repository 状態になった

つまり、rubric があっても agent の最終応答前 checklist に組み込まれていなければ、
明確な milestone でも `save_observation` が漏れうる。

## ADR-014 との関係

ADR-014 は、agent の自発 save に依存しない safety net として deterministic
capture 層を追加する。

この事象は ADR-014 の問題意識を補強する。

- agent 直接 save は precision-first だが、完了時に漏れることがある
- commit/push のような明確な milestone でも漏れうる
- ユーザー確認を前提にすれば回復できるが、普段遣いの根本解決にはならない

ただし raw capture が残るだけでは不十分である。ADR-014 がこの failure mode の
根本対策として成立するには、capture が有用な observation に昇格し、通常の
`search_memory` / dreaming pipeline で再利用可能になる必要がある。

## Phase 6 検証観点

### 1. capture が実際に保存されるか

ADR-014 実装後の Codex hook で、以下が Layer 1 capture として保存されるか確認する。

- `UserPromptSubmit`
- milestone command の `PostToolUse`
- `Stop`

### 2. milestone command の実行形と matcher

以下のような実運用 command が capture 対象になるか確認する。

- `git commit`
- `git push`
- `gh pr merge`
- `gh release create`
- `git add ... && git commit ...` のような複合 command

複合 command は tool payload や matcher 実装によって拾えない可能性があるため、
即時の設計決定ではなく観察対象とする。

### 3. Stop capture から有用な observation に昇格できるか

milestone command capture が不足していても、Stop capture の final response から
作業完了の `progress` observation を抽出できるか確認する。

期待される昇格内容の抽象例:

```text
private dotfiles repository で NixOS system package を追加し、
rebuild で反映確認後、commit を remote branch に push した。
```

### 4. duplicate が許容範囲か

ユーザー確認後の手動 `save_observation` と、capture 昇格による自動 observation が
二重保存される可能性がある。

Phase 6 では、重複が実害になる頻度を観察する。重複対策を実装するかは、
実測された duplicate 率と search / dreaming への影響を見て判断する。

### 5. ADR-012 nudge の必要性再評価

ADR-012 の milestone nudge は、ADR-014 の capture 層で同種の漏れを十分に回収できるなら
必要性が下がる可能性がある。

一方で、capture は raw event を残すだけで、agent 自身の判断理由や intent を常に十分に
復元できるとは限らない。ADR-012 を補助手段として残すかは、ADR-014 Phase 6 の観察後に
再評価する。

## 暫定結論

この事象は ADR-014 実装前の漏れ事例であり、現時点の未解決 bug として扱わない。

今後は同種の作業を実運用で行った際に、capture 保存、capture→observation 昇格、
重複率、noise 率を観察する。追加の checklist / nudge / matcher 強化は、観察結果を
見てから決める。

## 関連

- `docs/adr/0012-save-trigger-nudge.md`
- `docs/adr/0014-three-layer-capture-promotion.md`
- `integrations/codex/hooks/hooks.json`
- `integrations/codex/scripts/post_tool_use.py`
- `integrations/codex/scripts/stop.py`
