# nextcloud-note-mcp

MCP SDK は v2 系(`@modelcontextprotocol/server`)を使う。web 上の例の多くは v1 系(`@modelcontextprotocol/sdk`)で、import のパスと起動の書き方が違うので、そのまま写さない。v2 のドキュメントは https://ts.sdk.modelcontextprotocol.io/v2/ にある。

`src/` で `console.log` を使わない。stdio では stdout が JSON-RPC の通信路なので、1 行でも混ざるとクライアントとの通信が壊れる。ログは `console.error` に出す。

tool の description に、特定の利用者の運用ルール(ノートを置くカテゴリなど)を書かない。運用ルールは利用者の CLAUDE.md 側に置く。
