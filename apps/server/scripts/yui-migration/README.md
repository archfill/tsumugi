# yui → tsumugi migration tooling

Phase 4 (ADR-010) で行う「archfill 個人ぶんの memory データを yui → tsumugi に移行」のためのスクリプト一式。

## Pipeline

```
yui DB
  ↓ extract.ts (filter + transform 適用)
staging/*.jsonl
  ↓ ユーザが目視確認 + exclusions.txt 編集
  ↓ apply.ts (別途)
tsumugi (本番)
```

## 使い方

### 1. 抽出

```bash
YUI_DATABASE_URL=postgresql://postgres:***@<host>:5432/yui \
  pnpm exec tsx scripts/yui-migration/extract.ts
```

`staging/` に以下が生成される:

| ファイル             | 内容                                  |
| -------------------- | ------------------------------------- |
| `observations.jsonl` | 1 行 1 record の移行候補 observations |
| `memories.jsonl`     | 同 memories                           |
| `decisions.jsonl`    | 同 decisions                          |
| `stats.md`           | 削除内訳を集計した人間用サマリ        |
| `exclusions.txt`     | user 編集用、追加除外 ID を記入する   |

### 2. レビュー

1. **`stats.md` を最初に見る** — 削除件数の内訳を確認
2. `*.jsonl` を VS Code / less / jq で開いて目検
3. 怪しいレコードの `src_id` を `exclusions.txt` に追記 (1 行 1 ID)
4. narrative を直接 sanitize したい場合は jsonl を直接編集してもよい

### 3. 適用

(後日 apply.ts で実施)

```bash
TSUMUGI_API=https://tsumugi.archfill.com \
  pnpm exec tsx scripts/yui-migration/apply.ts
```

## Filter ルール (extract.ts で適用済)

ADR-010 で合意した内容を実装している。

### observations から削除

- `source = claude_mem_import` (legacy claude-mem import data)
- `kind = user_prompt` (yui の SKIP_PROMOTE_KINDS と同じ)
- `narrative` が NULL または 30 文字未満
- 「Read: /path」「Edit: /path」「Bash: cmd」等の thin tool 操作のみ

### memories から削除

- `importance < 3`
- 「File edit:」「Command run:」「session ended:」で始まる短い narrative
- 「Read: /path」等の thin tool パターン (narrative ≤ 120 文字)
- `yui_pg_password` / `secrets.yml` / `秘密鍵` 等の secrets 参照
- narrative 完全一致重複 (最初の 1 件のみ残す)

### decisions から削除

- `body` が空または極端に短い (10 文字未満)
- `status != active` (status='active' のみ取得)

## Transform ルール

### observations

- `source: claude_code` → `claude-code`、`codex` → `codex`、その他 → `other`
- `kind` → `type` マッピング:
  - `tool_use` / `file_edit` → `progress`
  - `session_summary` / `reflection` → `reflection`
  - `decision` → `decision`
  - `discovery` → `discovery`
  - `blocker` → `blocker`
  - 上記以外 → `other`
- `payload.narrative` → `content`
- `payload.facts` → `facts`
- 削除フィールド: `user_id`, `project_id`, `concepts`, `pending_*`, `source_observation_ids`, `embedding`

### memories

- すべて `kind=episodic` のまま投入 (yui は 1 種のみ)
- 削除フィールド: `user_id`, `project_id`, `pending_*`, `concepts`, `embedding`, `source_observation_ids`, `superseded_by`, `promoted_to_decision_id` 他

### decisions

- `title` と `body` がほぼ同じ場合が多いので `body` を `content` として使う
- 削除フィールド: 同上

## Embedding

tsumugi 側で再計算する (yui の embedding は sentence-transformers FP32、tsumugi は @xenova/transformers ONNX int8 で数値差があるため)。`apply.ts` で投入時に tsumugi の embedder を通す。

## Gitignore

`staging/` は内部データのため gitignore 済み。コミットしない。
