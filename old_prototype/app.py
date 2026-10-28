"""
ラズパイ側 在庫管理システム Webサーバー (Flask版) ＆ MQTT受信
仕様書 (仕様書.md) に準拠：
・Web画面提供 (index.html)
・M5StickCからの出庫データ受付 (MQTTトピック: degimono/checkout)
・入出庫API (POST /api/checkin, POST /api/checkout)
・入出庫履歴CSVダウンロード (GET /download/history.csv)
"""

import os
import io
import csv
import json
import threading
import time
from datetime import datetime
from flask import Flask, render_template, request, jsonify, Response

# paho-mqtt
try:
    import paho.mqtt.client as mqtt
    MQTT_AVAILABLE = True
except ImportError:
    MQTT_AVAILABLE = False

app = Flask(__name__, template_folder=".")

# ① 部品在庫テーブル（Master）初期ダミーデータ
parts_db = [
    {
        "part_id": "AB-1234",
        "name": "近接センサー",
        "location": "２Ｆー②",
        "stock": 2,           # 発注点(2)以下 -> 要発注警告テスト
        "reorder_point": 2,
        "departments": "T2、T4",
        "order_status": "未発注"
    },
    {
        "part_id": "CD-5678",
        "name": "マイクロスイッチ",
        "location": "２Ｆー①",
        "stock": 1,           # 発注点(5)以下だが発注済
        "reorder_point": 5,
        "departments": "T1、T2",
        "order_status": "発注済"
    },
    {
        "part_id": "EF-9012",
        "name": "ステッピングモーター",
        "location": "１ＦーＡ",
        "stock": 12,
        "reorder_point": 3,
        "departments": "T3",
        "order_status": "未発注"
    },
    {
        "part_id": "GH-3456",
        "name": "リニアガイドレール",
        "location": "１ＦーＢ",
        "stock": 4,           # 発注点ちょうど -> 要発注警告
        "reorder_point": 4,
        "departments": "T2、T4",
        "order_status": "未発注"
    },
    {
        "part_id": "JK-7890",
        "name": "電磁開閉器",
        "location": "３ＦーＣ",
        "stock": 8,
        "reorder_point": 2,
        "departments": "T1",
        "order_status": "未発注"
    }
]

# ② 入出庫履歴ログ（History）初期ダミーデータ
history_db = [
    {
        "datetime": "2026-10-14 13:45",
        "type": "出庫",
        "part_id": "AB-1234",
        "part_name": "近接センサー",
        "quantity": 1,
        "user_name": "田中次郎",
        "department": "製造部"
    },
    {
        "datetime": "2026-10-14 13:00",
        "type": "出庫",
        "part_id": "CD-5678",
        "part_name": "マイクロスイッチ",
        "quantity": 3,
        "user_name": "佐藤花子",
        "department": "開発部"
    },
    {
        "datetime": "2026-10-14 11:30",
        "type": "入庫",
        "part_id": "EF-9012",
        "part_name": "ステッピングモーター",
        "quantity": 10,
        "user_name": "鈴木一郎",
        "department": "資材課"
    },
    {
        "datetime": "2026-10-14 10:15",
        "type": "出庫",
        "part_id": "AB-1234",
        "part_name": "近接センサー",
        "quantity": 2,
        "user_name": "山田太郎",
        "department": "製造部"
    }
]


# ==============================================================================
# 出庫共通処理 (MQTTメッセージ受信時 ＆ HTTP POST /api/checkout で共通利用)
# ==============================================================================
def execute_checkout(user_name, department, part_id, quantity):
    """出庫処理を実行し、在庫減算とログ記録を行う"""
    part = next((p for p in parts_db if p["part_id"] == part_id), None)
    if not part:
        return {"status": "error", "message": f"部品 {part_id} が見つかりません"}

    if part["stock"] < quantity:
        return {
            "status": "error",
            "message": f"在庫不足です。(現在庫: {part['stock']}, 要求: {quantity})"
        }

    # 在庫数から減算
    part["stock"] -= quantity

    # 履歴ログに追加
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M")
    history_entry = {
        "datetime": now_str,
        "type": "出庫",
        "part_id": part_id,
        "part_name": part["name"],
        "quantity": quantity,
        "user_name": user_name or "未指定",
        "department": department or "製造部"
    }
    history_db.insert(0, history_entry)

    needs_reorder = (part["stock"] <= part["reorder_point"]) and (part["order_status"] == "未発注")
    print(f"[CHECKOUT SUCCESS] {user_name} ({department}) -> {part['name']} x {quantity}. Remaining: {part['stock']}")
    if needs_reorder:
        print(f"[REORDER ALERT] {part['name']} stock is below reorder point ({part['reorder_point']})!")

    return {
        "status": "ok",
        "message": f"{part['name']} を {quantity}個 出庫しました",
        "remaining_stock": part["stock"],
        "needs_reorder": needs_reorder
    }


# ==============================================================================
# MQTT バックグラウンドクライアント設定
# ==============================================================================
MQTT_BROKER_HOST = os.environ.get("MQTT_BROKER", "localhost")
MQTT_BROKER_PORT = int(os.environ.get("MQTT_PORT", 1883))
MQTT_TOPIC_CHECKOUT = "degimono/checkout"
MQTT_TOPIC_STATUS = "degimono/status"

mqtt_client = None

def on_mqtt_connect(client, userdata, flags, rc, properties=None):
    if rc == 0:
        print(f"[MQTT CONNECTED] Connected to broker ({MQTT_BROKER_HOST}:{MQTT_BROKER_PORT})")
        client.subscribe(MQTT_TOPIC_CHECKOUT)
        print(f"[MQTT SUBSCRIBED] Listening on topic: '{MQTT_TOPIC_CHECKOUT}'")
    else:
        print(f"[MQTT CONNECT ERROR] Code: {rc}")

def on_mqtt_message(client, userdata, msg):
    """M5StickCからの出庫メッセージを受信"""
    print(f"[MQTT MESSAGE RECEIVED] Topic: {msg.topic}")
    try:
        payload = msg.payload.decode("utf-8")
        data = json.loads(payload)
        
        user_name = data.get("user_name", "M5作業者")
        department = data.get("department", "製造部")
        part_id = data.get("part_id", "")
        quantity = int(data.get("quantity", 1))

        # 共通出庫処理を実行
        result = execute_checkout(user_name, department, part_id, quantity)

        # M5StickC向けに結果トピックへPublish (任意)
        response_payload = json.dumps(result, ensure_ascii=False)
        client.publish(MQTT_TOPIC_STATUS, response_payload)

    except Exception as e:
        print(f"[MQTT ERROR] Failed to process message: {e}")

def start_mqtt_client():
    """MQTTクライアントをバックグラウンドスレッドで開始"""
    global mqtt_client
    if not MQTT_AVAILABLE:
        print("[MQTT WARNING] paho-mqtt not available, skipping MQTT.")
        return

    try:
        # paho-mqtt v2 対応
        mqtt_client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="raspi-inventory-server")
    except AttributeError:
        # paho-mqtt v1 互換
        mqtt_client = mqtt.Client(client_id="raspi-inventory-server")

    mqtt_client.on_connect = on_mqtt_connect
    mqtt_client.on_message = on_mqtt_message

    def run_loop():
        while True:
            try:
                mqtt_client.connect(MQTT_BROKER_HOST, MQTT_BROKER_PORT, 60)
                mqtt_client.loop_forever()
            except Exception:
                time.sleep(10)

    thread = threading.Thread(target=run_loop, daemon=True)
    thread.start()


# ==============================================================================
# Web画面 (仕様書 3-② image.png 準拠)
# ==============================================================================
@app.route("/")
@app.route("/parts")
def index():
    return render_template("index.html")


# ==============================================================================
# Web API エンドポイント
# ==============================================================================

# 部品一覧取得
@app.route("/api/parts", methods=["GET"])
def get_parts():
    return jsonify(parts_db)


# 入出庫履歴一覧取得
@app.route("/api/history", methods=["GET"])
def get_history():
    return jsonify(history_db)


# 出庫API (HTTP POST /api/checkout)
# ※MQTTと併用可能！PCブラウザやcurlからもテストできます
@app.route("/api/checkout", methods=["POST"])
def api_checkout():
    data = request.get_json(silent=True) or {}
    user_name = data.get("user_name", "").strip()
    department = data.get("department", "").strip()
    part_id = data.get("part_id", "").strip()
    quantity = int(data.get("quantity", 0))

    if not part_id or quantity <= 0:
        return jsonify({"status": "error", "message": "無効なパラメータです"}), 400

    result = execute_checkout(user_name, department, part_id, quantity)
    status_code = 200 if result["status"] == "ok" else 400
    return jsonify(result), status_code


# 入庫API (HTTP POST /api/checkin)
@app.route("/api/checkin", methods=["POST"])
def api_checkin():
    data = request.get_json(silent=True)
    if not data:
        data = request.form

    part_id = data.get("part_id", "").strip()
    quantity = int(data.get("quantity", 0))
    worker_name = data.get("user_name", "担当者").strip()

    if not part_id or quantity <= 0:
        return jsonify({"status": "error", "message": "無効なパラメータです"}), 400

    part = next((p for p in parts_db if p["part_id"] == part_id), None)
    if not part:
        return jsonify({"status": "error", "message": f"部品 {part_id} が見つかりません"}), 404

    # 1. 在庫数に加算
    part["stock"] += quantity

    # 2. 履歴ログに追加
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M")
    history_entry = {
        "datetime": now_str,
        "type": "入庫",
        "part_id": part_id,
        "part_name": part["name"],
        "quantity": quantity,
        "user_name": worker_name,
        "department": "資材課"
    }
    history_db.insert(0, history_entry)

    # 3. 発注状態リセット
    part["order_status"] = "未発注"

    return jsonify({
        "status": "ok",
        "message": f"{part['name']} を {quantity}個 入庫しました",
        "current_stock": part["stock"]
    }), 200


# 発注状態更新トグルAPI
@app.route("/api/parts/<part_id>/order-status", methods=["POST"])
def update_order_status(part_id):
    part = next((p for p in parts_db if p["part_id"] == part_id), None)
    if not part:
        return jsonify({"status": "error", "message": "部品が見つかりません"}), 404

    data = request.get_json(silent=True) or {}
    new_status = data.get("order_status")
    if not new_status:
        new_status = "発注済" if part["order_status"] == "未発注" else "未発注"

    part["order_status"] = new_status
    return jsonify({"status": "ok", "order_status": new_status, "part_id": part_id})


# 履歴CSVダウンロード (GET /download/history.csv)
@app.route("/download/history.csv", methods=["GET"])
def download_history_csv():
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["日時", "種別", "品番", "品名", "変動数量", "作業者名", "使用部署"])

    for h in history_db:
        writer.writerow([
            h["datetime"],
            h["type"],
            h["part_id"],
            h.get("part_name", ""),
            h["quantity"],
            h["user_name"],
            h.get("department", "")
        ])

    csv_data = "\ufeff" + output.getvalue()
    filename = f"history_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv"

    return Response(
        csv_data,
        mimetype="text/csv; charset=utf-8",
        headers={"Content-Disposition": f"attachment; filename={filename}"}
    )


# アプリ起動時にMQTTバックグラウンドスレッドを開始
start_mqtt_client()


if __name__ == "__main__":
    print("=" * 65)
    print(" ラズパイ在庫管理システム (Webサーバー ＆ MQTT受信)")
    print(f" ・Web画面:   http://localhost:5000")
    print(f" ・MQTT受信:  トピック '{MQTT_TOPIC_CHECKOUT}' (Broker: {MQTT_BROKER_HOST}:{MQTT_BROKER_PORT})")
    print("=" * 65)
    app.run(host="0.0.0.0", port=5000, debug=True)
