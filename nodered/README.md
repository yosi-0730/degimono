# 在庫管理システム（Node-RED）

在庫管理システムの本体。画面（`../index.html`、`../m5_dummy.html`）と API、MQTT の出庫受付を Node-RED のフローで動かす。データは Node-RED のグローバルコンテキスト `degimono` に持ち、DB は使わない。

ラズパイへの構築・運用は `../docs/ラズパイ運用手順書.md`、自分で作り直すときの方針は `自作用の方針.md` にある。

## ファイル

| ファイル | 内容 |
|---|---|
| `make_flows.js` | フロー（`flows.json`）を作るスクリプト。画面の HTML を埋め込む。**開発の正はこのファイル** |
| `flows.json` | できたフロー。ラズパイで動いているもの |
| `flows_screen.json` | 「画面」タブだけのフロー（自作版を作るときに読み込む） |
| `deploy.js` | `flows.json` を PC からラズパイの Node-RED に入れるスクリプト |
| `自作用の方針.md` | 同じものを自分で作るときの方針と API の仕様 |

## 直して入れる

```bash
node make_flows.js     # flows.json と flows_screen.json を作る
node deploy.js         # ラズパイ（既定 192.168.50.2）に入れる
```

`deploy.js` は ID が `dc` で始まるノードだけを入れ替えるので、エディタで作ったほかのタブは残る。エディタで完成品のタブを直しても、次に入れ直すと上書きされる。

## URL

| URL | 内容 |
|---|---|
| `http://<ホスト>:1880/` | Node-RED のエディタ |
| `http://<ホスト>:1880/app` | 入出庫管理・発注管理の画面 |
| `http://<ホスト>:1880/m5-dummy` | M5StickC のダミー画面（QR 読み取り → 出庫） |
| `http://<ホスト>:1880/download/history.csv` | 入出庫履歴 CSV |

API の一覧と受け取るもの・返すものは `自作用の方針.md` の「API」にある。

## タブ

| タブ | 内容 |
|---|---|
| 画面（完成品） | `http in` → `template`（HTML）→ `http response` |
| 共通処理（完成品） | 「部品に状態を付ける」「履歴に残す」「履歴一覧を作る」。ほかのタブから link call で呼ぶ |
| データ準備（完成品） | 起動時にデータがなければデモデータを入れる。「デモデータに戻す」ボタン |
| 参照API（完成品） | 従業員・保管場所・部品・発注一覧・履歴・CSV（GET） |
| 登録API（完成品） | 部品登録・発注・入庫（POST） |
| 出庫（完成品） | HTTP（`/api/checkout`）と MQTT（`degimono/checkout`）の出庫を同じ流れで処理し、返し先を分ける。発注点以下なら `degimono/alert`（MQTT）と `/ws/alert`（WebSocket、ダミー画面用）に通知を送る |

## ノードの分け方

- コンテキストの読み書きは change ノード（「データを読む」で `msg.db` に出し、「保存する」で戻す）
- 何度も使う処理は「共通処理」タブに置き、link call で呼ぶ
- 分岐は switch ノード、決まった形の値やエラーの応答は change ノード（JSONata）
- function ノードは「部品を探す」「在庫を減らす」のように、一言で言える仕事だけをする

## MQTT

| トピック | 向き | 中身 |
|---|---|---|
| `degimono/checkout` | M5 → Node-RED | 出庫。`{part_id, quantity, user_name（または employee_id）, department}` |
| `degimono/status` | Node-RED → M5 | 出庫の結果 |
| `degimono/alert` | Node-RED → M5 | 発注点以下の通知。`text` を M5 の画面にそのまま出す |

ブローカーは `localhost:1883`（ラズパイの Docker の Mosquitto）。
