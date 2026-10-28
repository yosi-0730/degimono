# ラズパイ在庫管理システム

仕様は `docs/仕様書.md`（第6章が最新方針）を参照。Flask + SQLite 構成で、Web画面・API・MQTT受信を1プログラムで動かします。

## 画面

| URL | 内容 |
|---|---|
| `http://<ホスト>:5000/` | 入出庫管理（部品検索・工場配置図・発注登録ボタン・入庫登録）／発注管理一覧（未発注・入荷待ち） |
| `http://<ホスト>:5000/m5-dummy` | M5StickCのダミー画面（QR読取 → 出庫の流れを再現） |
| `http://<ホスト>:5000/download/history.csv` | 入出庫履歴CSV（UTF-8 BOM付き） |

## 起動方法

### A. Docker（Web + MQTTブローカーをまとめて起動）
```bash
docker compose up -d --build
```
- DBは `./data/degimono.db`（SQLite）に永続化されます。初回はデモ部品・従業員が自動投入されます。
- デモデータ不要なら `docker-compose.yml` の `SEED_DEMO: "0"` を有効化（従業員は常に投入）。
- 停止: `docker compose down` ／ ログ: `docker compose logs -f web`

### B. Dockerなし（開発・ラズパイ直接実行）
```bash
python -m venv .venv
.venv/bin/pip install -r requirements.txt          # Windows: .venv\Scripts\pip
.venv/bin/python app.py                            # Windows: run.bat でも可
```
MQTTは `MQTT_BROKER`（既定 localhost）に接続を試み続けます。ブローカー不要なら `MQTT_ENABLED=0`。
常駐させる場合は `gunicorn -b 0.0.0.0:5000 --workers 1 --threads 4 app:app` を systemd に登録します。

> ラズパイへの構築・運用の詳細手順は **`docs/ラズパイ運用手順書.md`** を参照（更新していく文書）。

### ラズパイでDockerは必要？
**必須ではありません。** 規模（社内の少人数・単一サーバー）なら、Dockerなしの B でも十分動きます。

| | Docker | Dockerなし |
|---|---|---|
| 向いている場面 | PCで開発した環境をそのままラズパイへ移したい／Mosquittoも一緒に入れたい | 手早く動かしたい／メモリの少ないラズパイ（Zero等） |
| 利点 | 環境差異が出ない、`docker compose up` だけ、MosquittoもコンテナでOK | 軽い、仕組みが単純、トラブル時に原因を追いやすい |
| 欠点 | Dockerの導入・理解が必要、少しメモリを使う | Python/Mosquittoを手動で入れる、PC環境と差が出ることがある |

迷ったら、まず Docker で運用し、重い・不要と感じたら B に切り替える、で問題ありません（DBファイルはそのまま移せます）。
ラズパイ（64bit推奨）では `curl -fsSL https://get.docker.com | sh` で導入できます。

## M5StickC（暫定）
M5側の詳細仕様は未確定のため、現状は次のダミーのみです。
- `/m5-dummy` … 手順書どおり 社員 → 部署 → 部品 → 個数 → A:決定／B:取消 を再現し `POST /api/checkout` を呼ぶ。QRの中身は「項目名,値」（`社員名,山田太郎` など。仕様書 6.6.1）。
- `m5stickc_mqtt_sample.ino` … 旧版のMQTT送信サンプル（固定値を送るだけ。QR読取は未実装）。

### 出庫API（HTTP / MQTT共通）
```bash
curl -X POST http://localhost:5000/api/checkout -H "Content-Type: application/json" \
  -d '{"employee_id":"1001","user_name":"山田太郎","department":"製造部","part_id":"AB-1234","quantity":1}'
```
- 入力: `part_id`, `quantity`, `employee_id`（または `user_name`）, `department`（使用部署。省略時は従業員の所属）
- 応答: `status`(`ok`/`error`), `stock`, `reorder_point`, `alert`（在庫≦発注点でM5がアラート音・メッセージ）, `alert_message`
- エラー: 400 パラメータ不正 / 404 従業員・部品なし / 409 在庫不足
- MQTT: トピック `degimono/checkout` に同じJSONをPublish → 結果は `degimono/status`

## その他API
`GET /api/employees` ／ `GET /api/parts?q=` ／ `POST /api/parts`（部品登録: `part_id`, `name`, `location`, `stock`, `reorder_point`, `departments`, `employee_id`）／ `GET /api/locations` ／ `GET /api/orders/unordered` ／ `GET /api/orders/waiting` ／
`POST /api/orders`（発注結果登録）／ `POST /api/checkin`（`order_id`, `employee_id`, `received_date`, `quantity`）／ `GET /api/history`

## ファイル構成
```text
app.py              Flask本体（API・SQLite・MQTT）
index.html          Web画面（入出庫管理／発注管理一覧）
m5_dummy.html       M5StickCダミー画面
Dockerfile / docker-compose.yml / mosquitto/   Docker一式
data/               SQLite DB（自動生成）
old_prototype/      旧仕様（メモリ上ダミーデータ版）の退避
```

## 現状の制約・今後
- 従業員は `app.py` の `EMPLOYEES`（ID・部署は仮）。実データが決まったら差し替え。
- 発注点アラートはM5向けにレスポンスで返すのみ（実機側の表示はM5仕様確定後）。
- Docker Desktop が停止中のため、`docker compose up` での実起動は未確認（compose構文のみ検証済み）。
