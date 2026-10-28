# 在庫管理システム（Node-RED 版）

授業用に、本体（`../app.py`、Flask）と同じ機能を Node-RED のフローで作り直したものです。本体はそのまま残しています。
入力チェックやエラー処理は最小限にしています。

## ファイル

| ファイル | 内容 |
|---|---|
| `flows.json` | Node-RED に読み込むフロー |
| `make_flows.js` | `flows.json` を作るスクリプト。画面（`../index.html`、`../m5_dummy.html`）を埋め込む |
| `flows_screen.json` | 「画面」タブだけのフロー。`make_flows.js` で一緒にできる |
| `make_flows_context.js` | コンテキスト版（SQLite を使わない）の `flows_context.json` を作るスクリプト |
| `flows_context.json` | コンテキスト版のフロー。ラズパイで動いているのはこちら |
| `コンテキスト版の方針.md` | SQLite を使わずコンテキストで作り直すときの方針 |
| `コンテキスト版の手順.md` | コンテキスト版の動かし方、ラズパイの今の状態、元に戻す方法 |

以下は SQLite 版の説明。ラズパイでは今はコンテキスト版を動かしていて、SQLite のノードは外してある。

## 動かし方

1. Node-RED を入れる。ラズパイなら公式のスクリプトで入ります。
   ```bash
   bash <(curl -sL https://github.com/node-red/linux-installers/releases/latest/download/update-nodejs-and-nodered-deb)
   sudo systemctl enable --now nodered
   ```
2. ブラウザで `http://<ホスト>:1880/` を開き、エディタの右上メニュー →「パレットの管理」→「ノードを追加」で **`node-red-node-sqlite`** を入れる。
3. 右上メニュー →「読み込み」で `flows.json` を選び、「デプロイ」を押す。
4. 画面を開く。

| URL | 内容 |
|---|---|
| `http://<ホスト>:1880/app` | 入出庫管理・発注管理の画面（本体の `/` と同じ） |
| `http://<ホスト>:1880/m5-dummy` | M5StickC のダミー画面 |
| `http://<ホスト>:1880/download/history.csv` | 入出庫履歴 CSV |

`http://<ホスト>:1880/` は Node-RED のエディタなので、画面は `/app` に置いています。

## フローの中身

| タブ | 内容 |
|---|---|
| 画面 | `http in` → `template`（HTML）→ `http response` |
| DB準備 | 起動時にテーブルを作り、部品が0件ならデモデータ（従業員・部品・入荷待ち3件）を入れる |
| 参照API | 従業員・部品・発注一覧・履歴・CSV（GET） |
| 登録API | 部品登録・発注結果・入庫（POST） |
| 出庫 | 出庫処理を1か所にまとめ、HTTP（`/api/checkout`）と MQTT（`degimono/checkout` → `degimono/status`）の両方から `link call` で呼ぶ |

SQL は SQLite ノードの中に書き、値は手前の function ノードで `msg.params` に入れて渡しています。

## 本体との違い

- DB は本体とは別のファイル `degimono_nr.db` です。Node-RED を起動したフォルダにできます。場所を決めたいときは、SQLite ノードの設定（`degimono_nr.db`）を絶対パスに書き換えます。
- 入力チェックはほとんどしていません。品番の重複など SQL のエラーは、各タブの `catch` ノードで 500 として返します。
- 出庫で従業員IDが見つからないときは、在庫は減りますが履歴に残りません。
- MQTT の接続先は `localhost:1883` です。**本体（Flask）と同時に動かすと、M5 からの出庫を両方が受け取ります。** 同時に動かすときは、どちらかの MQTT を止めてください（本体は `MQTT_ENABLED=0`）。

## 画面を直したとき

`../index.html` などを直したら、このフォルダで次を実行し、できた `flows.json` を読み込み直します。

```bash
node make_flows.js
```
