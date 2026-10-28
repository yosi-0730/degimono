# ラズパイ在庫管理システム

部品の入出庫と発注を管理するシステム。ラズパイの Node-RED で画面と API を動かし、M5StickC からの出庫を MQTT で受け取る。

- 仕様: `docs/仕様書.md`（第6章が最新方針）
- ラズパイの構築・運用: `docs/ラズパイ運用手順書.md`
- フローの中身: `nodered/README.md`

## 構成

| 部分 | 内容 |
|---|---|
| 画面・API | Node-RED（ポート1880）。フローは `nodered/make_flows.js` で作る |
| データ | Node-RED のグローバルコンテキスト（ファイルに保存。DB は使わない） |
| MQTT ブローカー | Mosquitto（ポート1883、Docker） |
| M5StickC | QR を読んで出庫を MQTT で送る。発注点以下の通知を受けて表示する |

## 画面

| URL | 内容 |
|---|---|
| `http://<ラズパイIP>:1880/app` | 入出庫管理（部品検索・工場配置図・発注登録・入庫登録）／発注管理一覧（未発注・入荷待ち） |
| `http://<ラズパイIP>:1880/m5-dummy` | M5StickC のダミー画面（QR 読み取り → 出庫の流れを再現。発注点以下の通知も表示） |
| `http://<ラズパイIP>:1880/download/history.csv` | 入出庫履歴 CSV（UTF-8 BOM 付き） |

今のラズパイは `192.168.50.2`（PC と LAN ケーブルで直結）。

## 開発の流れ

`index.html`、`m5_dummy.html`、`nodered/make_flows.js` を直したら、`nodered` フォルダで次を実行する。

```bash
node make_flows.js     # flows.json を作る
node deploy.js         # ラズパイの Node-RED に入れる
```

## ファイル構成

```text
index.html               Web画面（入出庫管理／発注管理一覧）
m5_dummy.html            M5StickC のダミー画面
nodered/                 Node-RED のフロー（make_flows.js が正）と deploy.js
m5stickc_mqtt_sample.ino M5StickC のサンプル（出庫の送信、通知の表示）
docker-compose.yml       Mosquitto（MQTT ブローカー）
mosquitto/               Mosquitto の設定
qr_generator.py          QR コードの HTML を作るスクリプト（出力は qr_output/）
docs/                    仕様書、運用手順書、画面イメージ
```

## これまでの経緯

2026-10-28 まで Flask + SQLite で作っていた（`app.py`）。Node-RED 版に移り、Flask 版は削除した。必要になったら git の最初のコミット `7a459e0` から取り出せる。
