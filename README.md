# nextcloud-note-mcp

Nextcloud の Notes アプリのノートを、Claude などの MCP クライアントから読み書きする stdio MCP サーバー。
検索はマッチした行と前後の数行だけを返す。本文の編集は、置き換える文字列だけを送れる。

## 依存

- Node.js 20 以上
- Notes アプリを入れた Nextcloud(Notes API 1.2 以上。Notes アプリ 4.1 以上)
  - 添付ファイルを扱うには Notes アプリ 4.12.3 以上(Notes API 1.4)。添付ファイルの削除は 6.1 以上

## セットアップ

```bash
git clone https://github.com/nattoujam/nextcloud-note-mcp.git
```

```bash
cd nextcloud-note-mcp && npm ci && npm run build
```

サーバーは次の環境変数で Nextcloud に接続する。

| 変数 | 値 |
|---|---|
| `NC_NOTES_URL` | Nextcloud の URL(例: `https://cloud.example.com`) |
| `NC_NOTES_USER` | ユーザー名 |
| `NC_NOTES_PASSWORD` | パスワード。[アプリパスワード](https://docs.nextcloud.com/server/latest/user_manual/en/session_management.html#managing-devices)を推奨 |

### Claude Code

```bash
claude mcp add --scope user nc-notes -e NC_NOTES_URL=https://cloud.example.com -e NC_NOTES_USER=your-user -e NC_NOTES_PASSWORD=your-app-password -- node /path/to/nextcloud-note-mcp/dist/index.js
```

### Claude Desktop

`claude_desktop_config.json` に追加する。ファイルの場所と開き方は[公式ドキュメント](https://modelcontextprotocol.io/docs/develop/connect-local-servers)を参照。

```json
{
  "mcpServers": {
    "nc-notes": {
      "command": "node",
      "args": ["/path/to/nextcloud-note-mcp/dist/index.js"],
      "env": {
        "NC_NOTES_URL": "https://cloud.example.com",
        "NC_NOTES_USER": "your-user",
        "NC_NOTES_PASSWORD": "your-app-password"
      }
    }
  }
}
```

### パスワードをクライアントの設定に書かない場合

3 つの変数をファイルにまとめ、起動時に読み込ませる。`NC_NOTES_URL=...` の形で 1 行に 1 つ書き、`chmod 600` にしておく。

```json
"command": "bash",
"args": ["-c", "set -a; . /path/to/nc-notes.env; exec node /path/to/nextcloud-note-mcp/dist/index.js"]
```

Claude Code では `claude mcp add` の `--` 以降に同じコマンドを渡す。

## 使い方

クライアントに頼むと、Claude が tool を選んで呼ぶ。

- 「Notes から〇〇について書いたメモを探して」
- 「この調査結果をノートとして保存して」
- 「さっきのノートの結論の段落を書き直して」
- 「この図をノートに添付して、本文に埋め込んで」

Claude Code では、`@nc-notes:notes://<id>` と書くとノートの本文を添付できる。

書き込みは次のように振る舞う。

- `edit_note` は指定した文字列を置き換える。文字列が見つからないとき、複数見つかるときは書き込まない。
- `update_note` で本文をまるごと置き換えるときは、`get_note` で読んだ etag が要る。そのあと別の端末で編集されていたら、上書きせずにエラーを返す。
- `create_note` のタイトルとカテゴリは、Nextcloud が記号を取り除いたり、同名のときに番号を付けたりする。返ってきた値が保存された名前になる。
- `add_attachment` はファイルをアップロードするだけで、本文は変えない。本文から参照するには、返ってきたパスを `edit_note` で `![図](<パス>)` の形で書き込む。パスを `<>` で囲まないと、ファイル名に空白があるときに画像として表示されない。

## 制限

- Notes API にはサーバー側の全文検索が無い。`search_notes` は呼ぶたびに全ノートの本文を取得するので、ノートが多いと遅くなる。
- Notes API には添付ファイルの一覧が無い。添付ファイルは、本文に書かれたパスを使って読む。
- Notes の画面は、SVG の添付ファイルを画像として表示しない。図は PNG で添付する。
- `get_attachment` で読めるのは、PNG・JPEG・GIF・WebP の画像と、テキストのファイル(SVG を含む)だけ。PDF などは読めない。
- stdio で動くので、同じマシンで動く MCP クライアントからしか使えない。claude.ai の web 版やモバイルアプリからは使えない。
- `delete_note` で消したノートは、Nextcloud の Deleted files アプリが有効ならゴミ箱から戻せる。

## ライセンス

MIT。[LICENSE](LICENSE) を参照。
