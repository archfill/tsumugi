# LLM resilience rules

このディレクトリでは、provider全体の障害とitem固有の失敗を分離する。

## エラー分類

- `ProviderUnavailableError` は、timeout・429・5xx・network failure・open circuitなど、providerへ有効なitem処理を依頼できない障害だけに使う。
- primaryがitem固有エラーでfallbackだけがprovider障害の場合、全体をprovider障害へ変換しない。primaryのitem分類を保持する。
- primaryとfallbackの両方をprovider unavailableとして扱える場合だけ、合成結果を `ProviderUnavailableError` にする。
- malformed response、schema validation、内容固有のpermanent errorをprovider cooldownで隠さない。

## Circuitとfailure count

- circuitはprovider endpointとcredentialの組み合わせで共有し、tierやjobごとに重複させない。
- open中は新しいLLM callを行わず、half-openでは単一probeだけを許可する。
- provider障害はitem quarantine用のfailure countを増やさない。
- item固有失敗はprovider障害として停止させず、既存のretry・quarantine経路へ渡す。
- retry、circuit transition、partial runのmetricsとログ分類を実際の状態遷移に合わせる。

## 検証

- fallbackまたは分類を変更するときは `apps/server/tests/resilience/singleton-fallback.test.ts` を更新する。
- 少なくとも primary item error + fallback unavailable、primary unavailable + fallback item error、両方 unavailable、fallback成功を分けて検証する。
- promotion側ではprovider障害がfailure countを増やさず、item固有失敗がquarantineへ進むことを確認する。
- 実provider smokeは外部接続が明示承認された場合だけ行う。
