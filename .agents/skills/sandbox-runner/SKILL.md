---
name: sandbox-runner
description: コマンドやプログラムを安全に実行するためのDockerサンドボックス指示書
---

# サンドボックス実行ルール

このプロジェクトでコマンドやプログラムの実行、またはパッケージのインストールを行う際は、Windowsホスト上で直接実行するのではなく、必ずDockerコンテナを介して実行してください。

## 実行手順の例
- **テストの実行:**
  - 誤: `npm test`
  - 正: `docker compose run --rm app npm test`
- **パッケージの追加:**
  - 誤: `npm install <package>`
  - 正: `docker compose run --rm app npm install <package>`
- **開発サーバーの起動:**
  - 正: `docker compose up`
