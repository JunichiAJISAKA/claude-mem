# ajio ブランチ運用手順(恒久フォーク)

最終更新: 2026-07-13

## 位置づけ

`ajio` は **upstream(thedotmack/claude-mem)最新 + 自分用パッチ**を常に統合して運用するための恒久ブランチ。upstream への PR は送らない方針(例外: 既存の CJK 修正 PR #3173 は放置してマージされれば携行パッチが減るのを待つ)。ローカルのプラグイン実体は常にこのブランチのビルドから配備する。

## 現在携行しているパッチ

| ブランチ | 内容 |
|---|---|
| `fix/fts5-fallback-empty-categories` | CJK(日本語)検索で observations が 0 件になる問題の FTS5 フォールバック修正 |
| `feature/semantic-inject-session-dedup` | セッション内で一度注入した観測を再注入しない重複排除(SQLite 永続・7日プルーニング・`CLAUDE_MEM_SEMANTIC_INJECT_DEDUP` トグル、default 有効) |

パッチを追加する場合: main ベースの独立ブランチで実装・テストし、`ajio` にマージしてこの表へ追記する。

## 日常運用

### プラグイン更新でパッチが消えたとき(最頻の作業)

プラグインが更新されるとキャッシュ配下のバンドルが素の状態に戻る。復旧は次の2ステップ:

```bash
cd ~/git/claude-mem
git checkout ajio
git fetch upstream && git merge upstream/main   # 最新へ追従(下記の衝突ルール参照)
bash scripts/apply-ajio-patches.sh              # ビルド→配備→worker再起動→検証まで自動
```

`apply-ajio-patches.sh` がやること: ajio ブランチ確認 → `npm run build` → キャッシュの最新バージョンディレクトリを自動検出 → 既存バンドルを `.bak-ajio-<日時>` で退避して `plugin/scripts/*.cjs` を配備 → worker 再起動 → 両パッチがバンドル内に存在することを grep 検証。

### upstream 同期時の衝突ルール(重要)

- **生成物(`plugin/scripts/*.cjs` などのバンドル)の衝突は手マージ禁止。** どちらか一方を機械的に採用して(`git checkout --ours <file>`)マージを完了させ、必ず最後に `npm run build` で**マージ済みソースから再生成**する。バンドルの中身はビルドが正とする。
- ソースコードの衝突のみ通常どおり解消する。
- 同期後は `bun test` が 0 fail であることを確認してから配備する。

### 動作確認

```bash
bun plugin/scripts/worker-service.cjs status          # worker 稼働確認
curl -s http://127.0.0.1:37777/api/health             # health エンドポイント
```

重複排除の効き目は実セッションで確認できる: 同じ話題のプロンプトを繰り返しても「Relevant Past Work」に同一観測が二度出なければ正常。無効化したい場合は `~/.claude-mem/settings.json` の `CLAUDE_MEM_SEMANTIC_INJECT_DEDUP` を `false` に。

## 出口戦略

upstream に同等機能が入った(または PR がマージされた)パッチは、次回同期時にマージで自然消滅するか、衝突したら upstream 側を採用して携行リストから削除する。携行パッチが 0 になったら `ajio` は廃止し、素のプラグイン運用へ戻す。
