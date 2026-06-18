/**
 * search_memory のデフォルト project_tag filter 解決 (ADR-013 G)。
 *
 * 役割: search_memory の MCP / REST 入口で、filter.project_tag が省略された
 * ときに session_id から自動補完する。これにより cross-project corpus
 * pollution (filter なしで他プロジェクトの obs が大量に拾われる) を
 * デフォルトで回避する。
 *
 * 解決順序:
 *   1. filter.project_tag が **明示** (string OR null) → そのまま使う
 *      - string  → 通常のフィルタ
 *      - null    → project_tag auto-fill の opt-out
 *   2. filter.project_tag が undefined && filter.session_id がある
 *      → observations から最新の project_tag を引いて補完
 *   3. どちらも未指定 → filter そのまま (現状維持) + WARN ログ
 *
 * 戻り値は filter オブジェクト (project_tag が解決済み)。
 * null は SearchInput schema 上は通せないので、解決後 filter からは
 * `project_tag` キーを削除する。
 */

import { observationRepo } from "../../data/repos/observation.js";
import { logger } from "../../lib/logger.js";
import type { SearchInput } from "@tsumugi/shared";

export type SearchFilter = NonNullable<SearchInput["filter"]>;

/**
 * SearchInput.filter から hybridSearch に渡せる形に変換する。
 * project_tag が null の場合は filter から除去する。
 * session_id / source / type など他の filter は維持する。
 */
export async function resolveSearchFilter(
  filter: SearchFilter | undefined,
): Promise<Omit<SearchFilter, "project_tag"> & { project_tag?: string }> {
  const f: SearchFilter = filter ? { ...filter } : {};

  // 1. project_tag auto-fill の opt-out (project_tag === null)
  if (f.project_tag === null) {
    const { project_tag: _drop, ...rest } = f;
    void _drop;
    return rest;
  }

  // 2. 明示的な string 指定はそのまま
  if (typeof f.project_tag === "string") {
    return f as Omit<SearchFilter, "project_tag"> & { project_tag: string };
  }

  // 3. project_tag が undefined: session_id から補完を試みる
  if (f.session_id) {
    const resolved = await observationRepo.getLatestProjectTagBySession(
      f.session_id,
    );
    if (resolved) {
      logger.debug(
        { session_id: f.session_id, project_tag: resolved },
        "search_memory: auto-resolved project_tag from session",
      );
      return { ...f, project_tag: resolved };
    }
    logger.debug(
      { session_id: f.session_id },
      "search_memory: session_id given but no project_tag found in observations",
    );
  }

  // 4. session_id も無い / 引けない → filter そのまま + WARN
  logger.warn(
    {
      hasSessionId: Boolean(f.session_id),
      hasOtherFilters: Boolean(f.type || f.source),
    },
    "search_memory called without project_tag — searching across all projects",
  );

  const { project_tag: _undef, ...rest } = f;
  void _undef;
  return rest;
}
