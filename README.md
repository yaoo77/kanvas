# kanvas

無限キャンバスとターミナルマルチプレクサを統合したデスクトップワークスペース。[Collaborator](https://github.com/collaborator-ai/collab-public) と [cmux](https://github.com/alumican/cmux-tb) を合成したElectronアプリ。

## 機能

### キャンバス
- 無限パン＆ズーム（ドットグリッド背景）
- ドラッグ・リサイズ可能なタイル
- 全画面モード（Sessionsパネルで切替）
- ダブルクリックでターミナル作成、右クリックメニュー
- Cmd+W でタイル閉じる

### ターミナル
- タイル内タブ（複数セッション管理）
- 無制限ペイン分割（縦横再帰ネスト）
- リサイズハンドル
- Send Command入力バー（IME対応、Shift+Enter改行）

### ファイル管理
- リアルタイム同期（ディスク変更を即反映）
- 再帰検索（3階層）
- ファイル・フォルダ作成ボタン
- 右クリック：Finderで表示、パスコピー、リネーム、ゴミ箱
- Shift+クリック複数選択＋パス一括コピー
- 変更インジケーター（青ドット）

### ビューア
- Markdown：Preview/Edit切替、Cmd+S保存
- HTML：Source/Preview切替、ライブリロード
- PDF：埋め込みビューア＋ズーム
- コード：Monaco Editorシンタックスハイライト
- 画像：ズームコントロール

### Git
- ブランチ表示＋リモートURL管理
- Pull（自動stash＋コンフリクト解決）
- Commit & Push（自動pull→push、upstream自動設定）
- 変更ファイル一覧（色分け）
- git init、リモート設定

### Sessionsパネル
- タイル作成：+ Terminal / + Browser / + Note
- タイル切替（キャンバスモード→自動パン、全画面モード→切替）
- 全画面トグルボタン

## 技術スタック

- **Electron 33** — デスクトップシェル
- **React 19** — UIフレームワーク
- **TypeScript** — 言語
- **@xterm/xterm 6** — ターミナルエミュレーション
- **Monaco Editor** — コードエディタ
- **electron-vite** — ビルドツール
- **bun** — パッケージマネージャ
- **node-pty** — PTY管理

## 開発

```bash
# 依存関係インストール
bun install

# 開発モード（ホットリロード）
bun run dev

# ビルド
bun run build

# ビルド済みアプリ起動
npx electron ./out/main/index.js

# 配布用パッケージ
bun run package
```

## プロジェクト構成

```
src/
  main/           # Electronメインプロセス
    index.ts      # アプリライフサイクル、ウィンドウ、IPC
    config.ts     # ~/.kawase/config.json 管理
    watcher.ts    # ファイル監視
    ipc/
      fs-handlers.ts        # ファイル操作
      pty-handlers.ts       # ターミナルPTY管理
      cmux-handlers.ts      # 内部コマンドルーティング
      workspace-handlers.ts # ワークスペース管理
      dialog-handlers.ts    # ネイティブダイアログ
      image-handlers.ts     # 画像処理（sharp）
  preload/
    shell.ts      # シェルウィンドウAPIブリッジ
    universal.ts  # 全webview APIブリッジ
  renderer/
    shell/        # キャンバスタイルシステム（vanilla TS）
    nav/          # ファイルツリー＋Sessions＋Gitパネル（React）
    viewer/       # ファイルビューア（React）
    terminal/     # サイドバーターミナル（React）
    terminal-tile/# キャンバスターミナル（タブ＋分割対応、React）
    graph-tile/   # ナレッジグラフ（Canvas API）
    settings/     # 設定パネル（React）
  components/
    CmuxToolbar.tsx  # ターミナルツールバー
packages/
  shared/         # 共有型定義
  cmux/           # コマンド定義
```

## ライセンス

MIT
