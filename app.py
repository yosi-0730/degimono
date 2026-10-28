"""
ラズパイ側 在庫管理システム (Flask + SQLite)
仕様書.md（第6章 2026-10-21 方針）に準拠：
・Web画面: 入出庫管理 / 発注管理一覧 (index.html 1本)
・M5StickCからの出庫受付: HTTP POST /api/checkout と MQTT degimono/checkout
・発注テーブルを分離（発注履歴を保持）、入庫は入荷待ちの発注から登録
・入出庫履歴CSV: GET /download/history.csv
"""

import csv
import io
import json
import os
import re
import sqlite3
import threading
import time
from datetime import datetime

from flask import Flask, Response, g, jsonify, request, send_file

try:
    import paho.mqtt.client as mqtt
    MQTT_AVAILABLE = True
except ImportError:
    MQTT_AVAILABLE = False

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("DB_PATH", os.path.join(BASE_DIR, "data", "degimono.db"))
SEED_DEMO = os.environ.get("SEED_DEMO", "1") == "1"

app = Flask(__name__)
app.json.ensure_ascii = False


# ==============================================================================
# DB
# ==============================================================================
SCHEMA = """
CREATE TABLE IF NOT EXISTS employees (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kana TEXT NOT NULL,
    department TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS parts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    location TEXT NOT NULL,
    stock INTEGER NOT NULL DEFAULT 0,
    reorder_point INTEGER NOT NULL DEFAULT 0,
    departments TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    part_id TEXT NOT NULL REFERENCES parts(id),
    quantity INTEGER NOT NULL,
    orderer_id TEXT NOT NULL REFERENCES employees(id),
    ordered_date TEXT NOT NULL,
    expected_date TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT '入荷待ち',   -- 入荷待ち / 入荷済
    received_date TEXT,
    received_qty INTEGER,
    receiver_id TEXT REFERENCES employees(id)
);
CREATE TABLE IF NOT EXISTS history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    kind TEXT NOT NULL,                       -- 出庫 / 入庫 / 発注 / 登録
    part_id TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    worker_id TEXT,
    worker_name TEXT,
    department TEXT,
    note TEXT DEFAULT ''
);
"""

# (社員ID, 氏名, よみ, 部署) ※社員QRは「社員名,山田太郎」で社員IDは入れない
EMPLOYEES = [
    ("1001", "山田太郎", "やまだたろう", "製造部"),
    ("1002", "相田健司", "あいだけんじ", "製造部"),
    ("1003", "佐々木徹", "ささきとおる", "製造部"),
    ("1004", "田中次郎", "たなかじろう", "製造部"),
    ("1005", "渡辺健一", "わたなべけんいち", "製造部"),
    ("2001", "木村拓哉", "きむらたくや", "開発部"),
    ("2002", "佐藤花子", "さとうはなこ", "開発部"),
    ("2003", "高橋涼介", "たかはしりょうすけ", "開発部"),
    ("2004", "本田翼", "ほんだつばさ", "開発部"),
    ("3001", "鈴木一郎", "すずきいちろう", "資材課"),
    ("3002", "斉藤和夫", "さいとうかずお", "資材課"),
    ("3003", "中村誠", "なかむらまこと", "資材課"),
    ("4001", "伊藤美咲", "いとうみさき", "品質管理部"),
    ("4002", "加藤進", "かとうすすむ", "品質管理部"),
    ("4003", "吉田裕子", "よしだゆうこ", "品質管理部"),
    ("5001", "小林正雄", "こばやしまさお", "設備保全課"),
    ("5002", "松本大樹", "まつもとだいき", "設備保全課"),
]
DEPARTMENTS = ["製造部", "開発部", "資材課", "品質管理部", "設備保全課"]
# 保管場所（工場配置図 index.html の mapHtml と一致させる）
LOCATIONS = ["A", "B", "C", "D", "E", "F", "部品棚"]

# (品番, 品名, 保管場所(棚), 在庫, 発注点, 使用部署)
PARTS = [
    ("AB-1234", "近接センサー", "A", 2, 2, "製造部、設備保全課"),
    ("CD-2040", "リレー", "B", 1, 3, "製造部、開発部"),
    ("EF-3050", "ヒューズ", "C", 0, 5, "設備保全課"),
    ("GH-4060", "ベアリング", "D", 8, 3, "製造部、設備保全課"),
    ("JK-5070", "エア継手", "E", 6, 4, "製造部"),
    ("LM-6080", "押しボタン", "F", 4, 2, "開発部、品質管理部"),
]
# 入荷待ちのデモ（画面イメージ準拠）: (品番, 数量, 発注者ID, 発注日, 入荷予定日)
DEMO_ORDERS = [
    ("GH-4060", 5, "3001", "2026-10-10", "2026-10-16"),
    ("JK-5070", 20, "3001", "2026-10-12", "2026-10-18"),
    ("LM-6080", 3, "3002", "2026-10-14", "2026-10-21"),
]


def connect():
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def get_db():
    if "db" not in g:
        g.db = connect()
    return g.db


@app.teardown_appcontext
def close_db(_exc):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def now_str():
    return datetime.now().strftime("%Y-%m-%d %H:%M")


def init_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    db = connect()
    try:
        db.executescript(SCHEMA)
        if db.execute("SELECT COUNT(*) FROM employees").fetchone()[0] == 0:
            db.executemany("INSERT INTO employees VALUES (?,?,?,?)", EMPLOYEES)
        if SEED_DEMO and db.execute("SELECT COUNT(*) FROM parts").fetchone()[0] == 0:
            db.executemany("INSERT INTO parts VALUES (?,?,?,?,?,?)", PARTS)
            for part_id, qty, emp_id, od, ed in DEMO_ORDERS:
                db.execute(
                    "INSERT INTO orders (part_id, quantity, orderer_id, ordered_date, expected_date) "
                    "VALUES (?,?,?,?,?)", (part_id, qty, emp_id, od, ed))
                emp = db.execute("SELECT * FROM employees WHERE id=?", (emp_id,)).fetchone()
                db.execute(
                    "INSERT INTO history (ts, kind, part_id, quantity, worker_id, worker_name, department, note) "
                    "VALUES (?,?,?,?,?,?,?,?)",
                    (od + " 10:00", "発注", part_id, qty, emp_id, emp["name"], emp["department"],
                     f"入荷予定日 {ed}"))
        db.commit()
    finally:
        db.close()


# ==============================================================================
# 共通ロジック
# ==============================================================================
def err(message, code=400):
    return {"status": "error", "message": message}, code


def jerr(message, code=400):
    body, code = err(message, code)
    return jsonify(body), code


def waiting_order(db, part_id):
    return db.execute(
        "SELECT * FROM orders WHERE part_id=? AND status='入荷待ち' ORDER BY id LIMIT 1",
        (part_id,)).fetchone()


def part_dict(db, row):
    d = dict(row)
    d["below_point"] = row["stock"] <= row["reorder_point"]
    w = waiting_order(db, row["id"])
    d["waiting_order"] = dict(w) if w else None
    # 画面表示用の状態: 入荷待ち / 要発注 / 発注不要
    if w:
        d["state"] = "入荷待ち"
    else:
        d["state"] = "要発注" if d["below_point"] else "発注不要"
    return d


def find_employee(db, employee_id=None, name=None):
    if employee_id:
        return db.execute("SELECT * FROM employees WHERE id=?", (str(employee_id).strip(),)).fetchone()
    if name:
        return db.execute("SELECT * FROM employees WHERE name=?", (str(name).strip(),)).fetchone()
    return None


def to_int(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def valid_date(s):
    try:
        datetime.strptime(s, "%Y-%m-%d")
        return True
    except (TypeError, ValueError):
        return False


def do_checkout(db, data):
    """出庫処理（HTTP/MQTT共通）。(レスポンスdict, HTTPコード) を返す。
    入力: part_id, quantity, employee_id または user_name, department(使用部署)"""
    part_id = str(data.get("part_id", "")).strip()
    qty = to_int(data.get("quantity"))
    if not part_id or qty is None or qty <= 0:
        return err("part_id と 1以上の quantity が必要です")

    emp = find_employee(db, data.get("employee_id"), data.get("user_name"))
    if emp is None:
        return err("従業員が見つかりません", 404)

    part = db.execute("SELECT * FROM parts WHERE id=?", (part_id,)).fetchone()
    if part is None:
        return err(f"部品 {part_id} が見つかりません", 404)

    department = (data.get("department") or "").strip() or emp["department"]

    # 在庫が足りるときだけ減算（原子的に実行）
    cur = db.execute("UPDATE parts SET stock = stock - ? WHERE id=? AND stock >= ?",
                     (qty, part_id, qty))
    if cur.rowcount == 0:
        db.rollback()
        return err(f"在庫不足です（現在庫: {part['stock']}, 要求: {qty}）", 409)
    db.execute(
        "INSERT INTO history (ts, kind, part_id, quantity, worker_id, worker_name, department) "
        "VALUES (?,?,?,?,?,?,?)",
        (now_str(), "出庫", part_id, qty, emp["id"], emp["name"], department))
    db.commit()

    after = db.execute("SELECT * FROM parts WHERE id=?", (part_id,)).fetchone()
    alert = after["stock"] <= after["reorder_point"]
    return {
        "status": "ok",
        "message": f"{after['name']} を {qty}個 出庫しました",
        "part_id": part_id,
        "part_name": after["name"],
        "stock": after["stock"],
        "reorder_point": after["reorder_point"],
        "alert": alert,  # True: M5でアラート音とメッセージを出す
        "alert_message": "在庫が発注点以下です。発注してください" if alert else "",
    }, 200


# ==============================================================================
# 画面
# ==============================================================================
@app.route("/")
@app.route("/parts")
def index():
    return send_file(os.path.join(BASE_DIR, "index.html"))


@app.route("/m5-dummy")
def m5_dummy():
    return send_file(os.path.join(BASE_DIR, "m5_dummy.html"))


@app.route("/healthz")
def healthz():
    return jsonify({"status": "ok"})


# ==============================================================================
# API
# ==============================================================================
@app.route("/api/employees")
def api_employees():
    db = get_db()
    rows = db.execute("SELECT id, name, department FROM employees ORDER BY kana").fetchall()
    return jsonify({"departments": DEPARTMENTS, "employees": [dict(r) for r in rows]})


@app.route("/api/parts")
def api_parts():
    db = get_db()
    q = (request.args.get("q") or "").strip()
    if q:
        like = f"%{q}%"
        rows = db.execute("SELECT * FROM parts WHERE id LIKE ? OR name LIKE ? ORDER BY id",
                          (like, like)).fetchall()
    else:
        rows = db.execute("SELECT * FROM parts ORDER BY id").fetchall()
    return jsonify([part_dict(db, r) for r in rows])


@app.route("/api/locations")
def api_locations():
    return jsonify(LOCATIONS)


@app.route("/api/parts", methods=["POST"])
def api_part_create():
    """部品（新商品）の登録。履歴に『登録』を残す。品番は重複不可。"""
    db = get_db()
    data = request.get_json(silent=True) or {}
    part_id = str(data.get("part_id", "")).strip()
    name = str(data.get("name", "")).strip()
    location = str(data.get("location", "")).strip()
    departments = str(data.get("departments", "")).strip()
    stock = to_int(data.get("stock", 0))
    reorder_point = to_int(data.get("reorder_point", 0))

    if not part_id:
        return jerr("品番を入力してください")
    # 品番はURL（/api/parts/<品番>）やQRにも使うため、空白とURL区切り文字は不可
    if len(part_id) > 40 or re.search(r"[\s/\\?#%]", part_id):
        return jerr("品番は40文字以内で、空白や / ? # % \\ は使えません")
    if not name:
        return jerr("品名を入力してください")
    if location not in LOCATIONS:
        return jerr("保管場所を選択してください")
    if stock is None or stock < 0:
        return jerr("初期在庫は0以上の整数で入力してください")
    if reorder_point is None or reorder_point < 0:
        return jerr("発注点は0以上の整数で入力してください")
    emp = find_employee(db, data.get("employee_id"))
    if emp is None:
        return jerr("登録担当者を選択してください")
    if db.execute("SELECT 1 FROM parts WHERE id=?", (part_id,)).fetchone():
        return jerr(f"品番 {part_id} は既に登録されています", 409)

    db.execute("INSERT INTO parts (id, name, location, stock, reorder_point, departments) "
               "VALUES (?,?,?,?,?,?)", (part_id, name, location, stock, reorder_point, departments))
    db.execute(
        "INSERT INTO history (ts, kind, part_id, quantity, worker_id, worker_name, department, note) "
        "VALUES (?,?,?,?,?,?,?,?)",
        (now_str(), "登録", part_id, stock, emp["id"], emp["name"], emp["department"],
         f"新規部品登録（初期在庫 {stock}、発注点 {reorder_point}）"))
    db.commit()
    return jsonify({"status": "ok", "message": f"{name}（{part_id}）を登録しました",
                    "part": part_dict(db, db.execute("SELECT * FROM parts WHERE id=?", (part_id,)).fetchone())}), 201


@app.route("/api/parts/<part_id>")
def api_part(part_id):
    db = get_db()
    row = db.execute("SELECT * FROM parts WHERE id=?", (part_id,)).fetchone()
    if row is None:
        return jerr("部品が見つかりません", 404)
    return jsonify(part_dict(db, row))


@app.route("/api/orders/unordered")
def api_orders_unordered():
    """発注管理一覧『未発注』: 入荷待ちの発注が無い部品。要発注を先頭に。"""
    db = get_db()
    rows = [part_dict(db, r) for r in db.execute("SELECT * FROM parts ORDER BY id").fetchall()]
    rows = [r for r in rows if r["waiting_order"] is None]
    rows.sort(key=lambda r: (not r["below_point"], r["id"]))
    return jsonify(rows)


@app.route("/api/orders/waiting")
def api_orders_waiting():
    """発注管理一覧『入荷待ち』: 入荷予定日順。"""
    db = get_db()
    rows = db.execute(
        "SELECT o.*, p.name AS part_name, p.location, p.stock, e.name AS orderer_name "
        "FROM orders o JOIN parts p ON p.id=o.part_id JOIN employees e ON e.id=o.orderer_id "
        "WHERE o.status='入荷待ち' ORDER BY o.expected_date, o.id").fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/api/orders/<int:order_id>")
def api_order(order_id):
    db = get_db()
    row = db.execute(
        "SELECT o.*, p.name AS part_name, e.name AS orderer_name FROM orders o "
        "JOIN parts p ON p.id=o.part_id JOIN employees e ON e.id=o.orderer_id WHERE o.id=?",
        (order_id,)).fetchone()
    if row is None:
        return jerr("発注が見つかりません", 404)
    return jsonify(dict(row))


@app.route("/api/orders", methods=["POST"])
def api_order_create():
    """発注結果の登録（別システムで発注した結果）。保存すると『入荷待ち』へ。"""
    db = get_db()
    data = request.get_json(silent=True) or {}
    part_id = str(data.get("part_id", "")).strip()
    qty = to_int(data.get("quantity"))
    ordered_date = data.get("ordered_date")
    expected_date = data.get("expected_date")

    if db.execute("SELECT 1 FROM parts WHERE id=?", (part_id,)).fetchone() is None:
        return jerr("部品が見つかりません", 404)
    emp = find_employee(db, data.get("employee_id"))
    if emp is None:
        return jerr("発注担当者を選択してください")
    if qty is None or qty <= 0:
        return jerr("発注数量は1以上で入力してください")
    if not valid_date(ordered_date) or not valid_date(expected_date):
        return jerr("発注日と入荷予定日を入力してください")
    if expected_date < ordered_date:
        return jerr("入荷予定日は発注日以降にしてください")
    if waiting_order(db, part_id):
        return jerr("この部品は既に入荷待ちです", 409)

    cur = db.execute(
        "INSERT INTO orders (part_id, quantity, orderer_id, ordered_date, expected_date) "
        "VALUES (?,?,?,?,?)", (part_id, qty, emp["id"], ordered_date, expected_date))
    db.execute(
        "INSERT INTO history (ts, kind, part_id, quantity, worker_id, worker_name, department, note) "
        "VALUES (?,?,?,?,?,?,?,?)",
        (now_str(), "発注", part_id, qty, emp["id"], emp["name"], emp["department"],
         f"入荷予定日 {expected_date}"))
    db.commit()
    return jsonify({"status": "ok", "order_id": cur.lastrowid, "message": "発注結果を保存しました（入荷待ちへ移動）"})


@app.route("/api/checkin", methods=["POST"])
def api_checkin():
    """入庫登録: 入荷待ちの発注を選び、実入荷日・数量を確定。在庫加算→入荷済へ。"""
    db = get_db()
    data = request.get_json(silent=True) or {}
    order_id = to_int(data.get("order_id"))
    order = db.execute("SELECT * FROM orders WHERE id=?", (order_id,)).fetchone() if order_id else None
    if order is None:
        return jerr("発注が見つかりません", 404)
    if order["status"] != "入荷待ち":
        return jerr("この発注は既に入荷済みです", 409)
    emp = find_employee(db, data.get("employee_id"))
    if emp is None:
        return jerr("入庫担当者を選択してください")
    qty = to_int(data.get("quantity", order["quantity"]))
    if qty is None or qty <= 0:
        return jerr("入荷数量は1以上で入力してください")
    received_date = data.get("received_date")
    if not valid_date(received_date):
        return jerr("実入荷日を入力してください")

    db.execute("UPDATE parts SET stock = stock + ? WHERE id=?", (qty, order["part_id"]))
    db.execute(
        "UPDATE orders SET status='入荷済', received_date=?, received_qty=?, receiver_id=? WHERE id=?",
        (received_date, qty, emp["id"], order["id"]))
    db.execute(
        "INSERT INTO history (ts, kind, part_id, quantity, worker_id, worker_name, department, note) "
        "VALUES (?,?,?,?,?,?,?,?)",
        (received_date + " " + datetime.now().strftime("%H:%M"), "入庫", order["part_id"], qty,
         emp["id"], emp["name"], emp["department"], f"発注ID {order['id']} 入荷"))
    db.commit()
    part = db.execute("SELECT * FROM parts WHERE id=?", (order["part_id"],)).fetchone()
    return jsonify({"status": "ok", "message": f"{part['name']} を {qty}個 入庫しました",
                    "stock": part["stock"]})


@app.route("/api/checkout", methods=["POST"])
def api_checkout():
    data = request.get_json(silent=True) or {}
    result, code = do_checkout(get_db(), data)
    return jsonify(result), code


@app.route("/api/history")
def api_history():
    db = get_db()
    rows = db.execute(
        "SELECT h.*, p.name AS part_name FROM history h LEFT JOIN parts p ON p.id=h.part_id "
        "ORDER BY h.ts DESC, h.id DESC LIMIT 200").fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/download/history.csv")
def download_history_csv():
    db = get_db()
    rows = db.execute(
        "SELECT h.*, p.name AS part_name FROM history h LEFT JOIN parts p ON p.id=h.part_id "
        "ORDER BY h.ts DESC, h.id DESC").fetchall()
    out = io.StringIO()
    w = csv.writer(out)
    w.writerow(["日時", "種別", "品番", "品名", "変動数量", "作業者名", "使用部署", "備考"])
    for r in rows:
        w.writerow([r["ts"], r["kind"], r["part_id"], r["part_name"] or "", r["quantity"],
                    r["worker_name"] or "", r["department"] or "", r["note"] or ""])
    filename = f"history_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv"
    return Response("﻿" + out.getvalue(), mimetype="text/csv; charset=utf-8",
                    headers={"Content-Disposition": f"attachment; filename={filename}"})


# ==============================================================================
# MQTT (M5StickC -> degimono/checkout, 結果は degimono/status へ)
# ==============================================================================
MQTT_BROKER_HOST = os.environ.get("MQTT_BROKER", "localhost")
MQTT_BROKER_PORT = int(os.environ.get("MQTT_PORT", 1883))
MQTT_ENABLED = os.environ.get("MQTT_ENABLED", "1") == "1"
MQTT_TOPIC_CHECKOUT = "degimono/checkout"
MQTT_TOPIC_STATUS = "degimono/status"


def on_mqtt_connect(client, userdata, flags, rc, properties=None):
    if rc == 0:
        print(f"[MQTT] connected {MQTT_BROKER_HOST}:{MQTT_BROKER_PORT}, subscribe '{MQTT_TOPIC_CHECKOUT}'")
        client.subscribe(MQTT_TOPIC_CHECKOUT)
    else:
        print(f"[MQTT] connect error rc={rc}")


def on_mqtt_message(client, userdata, msg):
    db = connect()
    try:
        data = json.loads(msg.payload.decode("utf-8"))
        result, _code = do_checkout(db, data)
    except Exception as e:  # 不正なペイロード等
        result = {"status": "error", "message": f"処理に失敗しました: {e}"}
    finally:
        db.close()
    client.publish(MQTT_TOPIC_STATUS, json.dumps(result, ensure_ascii=False))


def start_mqtt_client():
    if not (MQTT_ENABLED and MQTT_AVAILABLE):
        print("[MQTT] disabled")
        return
    try:
        client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="raspi-inventory-server")
    except AttributeError:  # paho-mqtt v1
        client = mqtt.Client(client_id="raspi-inventory-server")
    client.on_connect = on_mqtt_connect
    client.on_message = on_mqtt_message

    def run_loop():
        while True:
            try:
                client.connect(MQTT_BROKER_HOST, MQTT_BROKER_PORT, 60)
                client.loop_forever()
            except Exception:
                time.sleep(10)

    threading.Thread(target=run_loop, daemon=True).start()


init_db()
start_mqtt_client()

if __name__ == "__main__":
    print("=" * 60)
    print(" ラズパイ在庫管理システム  http://localhost:5000")
    print(" M5ダミー画面              http://localhost:5000/m5-dummy")
    print("=" * 60)
    app.run(host="0.0.0.0", port=5000, debug=False)
