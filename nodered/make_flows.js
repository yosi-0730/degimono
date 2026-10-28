// Node-RED 版のフロー（flows.json）を作るスクリプト
// 使い方: node make_flows.js  → 同じフォルダに flows.json ができる
// 画面（../index.html, ../m5_dummy.html）はテンプレートノードに埋め込むので、
// 画面を直したらこのスクリプトを実行し直して flows.json を読み込み直す。

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DB_FILE = "degimono_nr.db"; // Node-RED を起動したフォルダに作られる（README 参照）

// ------------------------------------------------------------------------------
// ノードを作る道具
// ------------------------------------------------------------------------------
let seq = 0;
const nid = () => "dg" + (++seq).toString(16).padStart(6, "0");
const nodes = [];

function tab(label, info = "") {
  const t = { id: nid(), type: "tab", label, disabled: false, info };
  nodes.push(t);
  return t.id;
}

// 横一列にノードを並べ、左から順につなぐ。最後のノードを返す
function chain(z, y, specs, x0 = 140) {
  const made = specs.map((s, i) => ({ id: nid(), z, x: x0 + i * 200, y, wires: [], ...s }));
  for (let i = 0; i < made.length - 1; i++) {
    if (made[i].wires.length === 0) made[i].wires = [[made[i + 1].id]];
  }
  made.forEach(n => {
    if (n.type === "http response" || n.type === "mqtt out" || n.type === "debug" ||
        n.type === "comment" || (n.type === "link out")) n.wires = [];
    nodes.push(n);
  });
  return made;
}

const comment = (name, info = "") => ({ type: "comment", name, info });
const httpIn = (method, url) => ({ type: "http in", name: "", url, method, upload: false, swaggerDoc: "" });
const httpRes = (headers = {}) => ({ type: "http response", name: "", statusCode: "", headers });
const fn = (name, func, outputs = 1) => ({
  type: "function", name, func, outputs, timeout: 0, noerr: 0, initialize: "", finalize: "", libs: [],
});
const tmpl = (name, template) => ({
  type: "template", name, field: "payload", fieldType: "msg", format: "html", syntax: "plain", template, output: "str",
});
const debug = name => ({
  type: "debug", name, active: true, tosidebar: true, console: false, tostatus: false,
  complete: "payload", targetType: "msg", statusVal: "", statusType: "auto",
});

const DB_ID = nid();
// prepared: SQL はノードに書き、値は msg.params（{$名前: 値}）で渡す
const sql = (name, query) => ({ type: "sqlite", mydb: DB_ID, sqlquery: "prepared", sql: query, name });
// batch: msg.topic の SQL をそのまま実行（複数文可、値の受け渡しなし）
const sqlBatch = name => ({ type: "sqlite", mydb: DB_ID, sqlquery: "batch", sql: "", name });

// HTTP のエラーを JSON で返す catch（タブごとに置く）
function httpCatch(z, y) {
  chain(z, y, [
    { type: "catch", name: "エラーを拾う", scope: null, uncaught: false },
    fn("エラー応答", `msg.statusCode = 500;
msg.payload = { status: "error", message: "処理に失敗しました: " + msg.error.message };
return msg;`),
    httpRes(),
  ]);
}

// ------------------------------------------------------------------------------
// 共通の SQL・データ
// ------------------------------------------------------------------------------
// 部品 + 入荷待ちの発注（あれば1件）。app.py の part_dict に相当
const PART_SQL = `SELECT p.*, p.stock <= p.reorder_point AS below_point,
  (SELECT json_object('id', o.id, 'part_id', o.part_id, 'quantity', o.quantity,
     'orderer_id', o.orderer_id, 'ordered_date', o.ordered_date,
     'expected_date', o.expected_date, 'status', o.status)
   FROM orders o WHERE o.part_id = p.id AND o.status = '入荷待ち' ORDER BY o.id LIMIT 1) AS waiting_order
FROM parts p`;

// SQLite の結果を画面が使う形（below_point, waiting_order, state）に整える
const SHAPE_PARTS = `msg.payload = msg.payload.map(p => {
    p.below_point = p.below_point === 1;
    p.waiting_order = p.waiting_order ? JSON.parse(p.waiting_order) : null;
    p.state = p.waiting_order ? "入荷待ち" : (p.below_point ? "要発注" : "発注不要");
    return p;
});`;

const SCHEMA = `CREATE TABLE IF NOT EXISTS employees (
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
    part_id TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    orderer_id TEXT NOT NULL,
    ordered_date TEXT NOT NULL,
    expected_date TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT '入荷待ち',
    received_date TEXT,
    received_qty INTEGER,
    receiver_id TEXT
);
CREATE TABLE IF NOT EXISTS history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    kind TEXT NOT NULL,
    part_id TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    worker_id TEXT,
    worker_name TEXT,
    department TEXT,
    note TEXT DEFAULT ''
);`;

// 履歴の追加。作業者名と部署は employees から引く
const HISTORY_SQL = (kind, ts = "strftime('%Y-%m-%d %H:%M', 'now', 'localtime')") =>
  `INSERT INTO history (ts, kind, part_id, quantity, worker_id, worker_name, department, note)
SELECT ${ts}, '${kind}', $part_id, $quantity, id, name, department, $note
FROM employees WHERE id = $employee_id`;

const DEPARTMENTS = ["製造部", "開発部", "資材課", "品質管理部", "設備保全課"];
const LOCATIONS = ["A", "B", "C", "D", "E", "F", "部品棚"];

// ==============================================================================
// タブ1: 画面
// ==============================================================================
{
  const z = tab("画面", "元の index.html / m5_dummy.html をそのまま返す。");
  chain(z, 40, [comment("画面（HTML はテンプレートノードの中）。/ は Node-RED のエディタなので /app で開く")]);
  const indexHtml = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const m5Html = fs.readFileSync(path.join(ROOT, "m5_dummy.html"), "utf8");
  const [, t] = chain(z, 100, [httpIn("get", "/app"), tmpl("入出庫管理画面", indexHtml),
    httpRes({ "content-type": "text/html; charset=utf-8" })]);
  const [p] = chain(z, 160, [httpIn("get", "/parts")]);
  p.wires = [[t.id]];
  chain(z, 220, [httpIn("get", "/m5-dummy"), tmpl("M5ダミー画面", m5Html),
    httpRes({ "content-type": "text/html; charset=utf-8" })]);
}

// ==============================================================================
// タブ2: 起動時の準備（テーブル作成・デモデータ）
// ==============================================================================
{
  const z = tab("DB準備", "起動時にテーブルを作り、部品が0件ならデモデータを入れる。");
  chain(z, 40, [comment("起動時: テーブル作成 → 部品が0件ならデモデータ投入")]);
  chain(z, 100, [
    { type: "inject", name: "起動時に1回", props: [{ p: "payload" }], repeat: "", crontab: "",
      once: true, onceDelay: "0.5", topic: "", payload: "", payloadType: "date" },
    fn("テーブル作成SQL", `msg.topic = ${JSON.stringify(SCHEMA)};
return msg;`),
    sqlBatch("テーブル作成"),
    fn("件数を数える", `msg.params = {};
return msg;`),
    sql("部品の件数", "SELECT COUNT(*) AS n FROM parts"),
    fn("デモデータSQL", `// (社員ID, 氏名, よみ, 部署)
const EMPLOYEES = [
    ["1001", "山田太郎", "やまだたろう", "製造部"],
    ["1002", "相田健司", "あいだけんじ", "製造部"],
    ["1003", "佐々木徹", "ささきとおる", "製造部"],
    ["1004", "田中次郎", "たなかじろう", "製造部"],
    ["1005", "渡辺健一", "わたなべけんいち", "製造部"],
    ["2001", "木村拓哉", "きむらたくや", "開発部"],
    ["2002", "佐藤花子", "さとうはなこ", "開発部"],
    ["2003", "高橋涼介", "たかはしりょうすけ", "開発部"],
    ["2004", "本田翼", "ほんだつばさ", "開発部"],
    ["3001", "鈴木一郎", "すずきいちろう", "資材課"],
    ["3002", "斉藤和夫", "さいとうかずお", "資材課"],
    ["3003", "中村誠", "なかむらまこと", "資材課"],
    ["4001", "伊藤美咲", "いとうみさき", "品質管理部"],
    ["4002", "加藤進", "かとうすすむ", "品質管理部"],
    ["4003", "吉田裕子", "よしだゆうこ", "品質管理部"],
    ["5001", "小林正雄", "こばやしまさお", "設備保全課"],
    ["5002", "松本大樹", "まつもとだいき", "設備保全課"],
];
// (品番, 品名, 保管場所, 在庫, 発注点, 使用部署)
const PARTS = [
    ["AB-1234", "近接センサー", "A", 2, 2, "製造部、設備保全課"],
    ["CD-2040", "リレー", "B", 1, 3, "製造部、開発部"],
    ["EF-3050", "ヒューズ", "C", 0, 5, "設備保全課"],
    ["GH-4060", "ベアリング", "D", 8, 3, "製造部、設備保全課"],
    ["JK-5070", "エア継手", "E", 6, 4, "製造部"],
    ["LM-6080", "押しボタン", "F", 4, 2, "開発部、品質管理部"],
];
// 入荷待ちのデモ: (品番, 数量, 発注者ID, 発注日, 入荷予定日)
const ORDERS = [
    ["GH-4060", 5, "3001", "2026-10-10", "2026-10-16"],
    ["JK-5070", 20, "3001", "2026-10-12", "2026-10-18"],
    ["LM-6080", 3, "3002", "2026-10-14", "2026-10-21"],
];
const q = v => typeof v === "number" ? v : "'" + String(v).replace(/'/g, "''") + "'";
const row = r => "(" + r.map(q).join(",") + ")";

let s = "INSERT OR IGNORE INTO employees VALUES " + EMPLOYEES.map(row).join(",") + ";\\n";
if (msg.payload[0].n === 0) {
    s += "INSERT INTO parts VALUES " + PARTS.map(row).join(",") + ";\\n";
    for (const [part, qty, emp, od, ed] of ORDERS) {
        s += "INSERT INTO orders (part_id, quantity, orderer_id, ordered_date, expected_date) VALUES "
            + row([part, qty, emp, od, ed]) + ";\\n";
        s += "INSERT INTO history (ts, kind, part_id, quantity, worker_id, worker_name, department, note) "
            + "SELECT " + q(od + " 10:00") + ", '発注', " + q(part) + ", " + qty + ", id, name, department, "
            + q("入荷予定日 " + ed) + " FROM employees WHERE id = " + q(emp) + ";\\n";
    }
}
msg.topic = s;
return msg;`),
    sqlBatch("デモデータ投入"),
    fn("完了", `msg.payload = "DB準備完了";
return msg;`),
    debug("DB準備"),
  ]);
}

// ==============================================================================
// タブ3: 参照API
// ==============================================================================
{
  const z = tab("参照API", "画面が一覧や詳細を取りに来る GET の API。");
  chain(z, 40, [comment("GET の API（画面からの読み込み）")]);

  chain(z, 100, [httpIn("get", "/api/employees"),
    fn("条件なし", `msg.params = {};
return msg;`),
    sql("従業員一覧", "SELECT id, name, department FROM employees ORDER BY kana"),
    fn("部署と一緒に返す", `msg.payload = { departments: ${JSON.stringify(DEPARTMENTS)}, employees: msg.payload };
return msg;`),
    httpRes()]);

  chain(z, 160, [httpIn("get", "/api/locations"),
    fn("保管場所一覧", `msg.payload = ${JSON.stringify(LOCATIONS)};
return msg;`),
    httpRes()]);

  chain(z, 220, [httpIn("get", "/api/parts"),
    fn("検索語", `msg.params = { $q: "%" + (msg.req.query.q || "").trim() + "%" };
return msg;`),
    sql("部品検索", PART_SQL + "\nWHERE p.id LIKE $q OR p.name LIKE $q ORDER BY p.id"),
    fn("形を整える", SHAPE_PARTS + "\nreturn msg;"),
    httpRes()]);

  chain(z, 280, [httpIn("get", "/api/parts/:id"),
    fn("品番", `msg.params = { $id: msg.req.params.id };
return msg;`),
    sql("部品1件", PART_SQL + "\nWHERE p.id = $id"),
    fn("形を整える（1件）", SHAPE_PARTS + `
if (msg.payload.length === 0) {
    msg.statusCode = 404;
    msg.payload = { status: "error", message: "部品が見つかりません" };
} else {
    msg.payload = msg.payload[0];
}
return msg;`),
    httpRes()]);

  chain(z, 340, [httpIn("get", "/api/orders/unordered"),
    fn("条件なし", `msg.params = {};
return msg;`),
    sql("全部品", PART_SQL + "\nORDER BY p.id"),
    fn("未発注だけ・要発注を先頭", SHAPE_PARTS + `
msg.payload = msg.payload
    .filter(p => p.waiting_order === null)
    .sort((a, b) => (b.below_point - a.below_point) || a.id.localeCompare(b.id));
return msg;`),
    httpRes()]);

  chain(z, 400, [httpIn("get", "/api/orders/waiting"),
    fn("条件なし", `msg.params = {};
return msg;`),
    sql("入荷待ち一覧", `SELECT o.*, p.name AS part_name, p.location, p.stock, e.name AS orderer_name
FROM orders o JOIN parts p ON p.id = o.part_id JOIN employees e ON e.id = o.orderer_id
WHERE o.status = '入荷待ち' ORDER BY o.expected_date, o.id`),
    httpRes()]);

  const HISTORY_LIST = `SELECT h.*, p.name AS part_name FROM history h LEFT JOIN parts p ON p.id = h.part_id
ORDER BY h.ts DESC, h.id DESC`;
  chain(z, 460, [httpIn("get", "/api/history"),
    fn("条件なし", `msg.params = {};
return msg;`),
    sql("履歴（新しい順200件）", HISTORY_LIST + " LIMIT 200"),
    httpRes()]);

  chain(z, 520, [httpIn("get", "/download/history.csv"),
    fn("条件なし", `msg.params = {};
return msg;`),
    sql("履歴（全件）", HISTORY_LIST),
    fn("CSVにする", `const cell = v => {
    const s = String(v ?? "");
    return /[",\\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const lines = [["日時", "種別", "品番", "品名", "変動数量", "作業者名", "使用部署", "備考"]];
for (const r of msg.payload) {
    lines.push([r.ts, r.kind, r.part_id, r.part_name, r.quantity, r.worker_name, r.department, r.note]);
}
msg.payload = "\\ufeff" + lines.map(l => l.map(cell).join(",")).join("\\r\\n") + "\\r\\n";
msg.headers = {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": "attachment; filename=history.csv",
};
return msg;`),
    httpRes()]);

  httpCatch(z, 600);
}

// ==============================================================================
// タブ4: 登録API（部品登録・発注・入庫）
// ==============================================================================
{
  const z = tab("登録API", "画面からの登録（POST）。入力チェックは最小限。");

  chain(z, 40, [comment("部品登録 POST /api/parts")]);
  chain(z, 100, [httpIn("post", "/api/parts"),
    fn("部品の値", `const d = msg.payload;
msg.data = d;
msg.params = {
    $id: String(d.part_id || "").trim(),
    $name: String(d.name || "").trim(),
    $location: d.location || "",
    $stock: Number(d.stock) || 0,
    $reorder_point: Number(d.reorder_point) || 0,
    $departments: d.departments || "",
};
return msg;`),
    sql("部品を追加", `INSERT INTO parts (id, name, location, stock, reorder_point, departments)
VALUES ($id, $name, $location, $stock, $reorder_point, $departments)`),
    fn("履歴の値", `const d = msg.data;
msg.params = {
    $part_id: d.part_id, $quantity: Number(d.stock) || 0, $employee_id: d.employee_id,
    $note: "新規部品登録（初期在庫 " + (Number(d.stock) || 0) + "、発注点 " + (Number(d.reorder_point) || 0) + "）",
};
return msg;`),
    sql("履歴に登録", HISTORY_SQL("登録")),
    fn("品番", `msg.params = { $id: msg.data.part_id };
return msg;`),
    sql("登録した部品", PART_SQL + "\nWHERE p.id = $id"),
    fn("応答", SHAPE_PARTS + `
msg.statusCode = 201;
msg.payload = { status: "ok", message: msg.data.name + "（" + msg.data.part_id + "）を登録しました", part: msg.payload[0] };
return msg;`),
    httpRes()]);

  chain(z, 180, [comment("発注結果の登録 POST /api/orders")]);
  chain(z, 240, [httpIn("post", "/api/orders"),
    fn("発注の値", `const d = msg.payload;
msg.data = d;
msg.params = {
    $part_id: d.part_id, $quantity: Number(d.quantity), $orderer_id: d.employee_id,
    $ordered_date: d.ordered_date, $expected_date: d.expected_date,
};
return msg;`),
    sql("発注を追加", `INSERT INTO orders (part_id, quantity, orderer_id, ordered_date, expected_date)
VALUES ($part_id, $quantity, $orderer_id, $ordered_date, $expected_date)`),
    fn("履歴の値", `const d = msg.data;
msg.params = {
    $part_id: d.part_id, $quantity: Number(d.quantity), $employee_id: d.employee_id,
    $note: "入荷予定日 " + d.expected_date,
};
return msg;`),
    sql("履歴に発注", HISTORY_SQL("発注")),
    fn("応答", `msg.payload = { status: "ok", message: "発注結果を保存しました（入荷待ちへ移動）" };
return msg;`),
    httpRes()]);

  chain(z, 320, [comment("入庫登録 POST /api/checkin（在庫を足す → 発注を入荷済に → 履歴）")]);
  chain(z, 380, [httpIn("post", "/api/checkin"),
    fn("入庫の値", `const d = msg.payload;
msg.data = d;
msg.params = { $order_id: Number(d.order_id), $quantity: Number(d.quantity) };
return msg;`),
    sql("在庫を足す", `UPDATE parts SET stock = stock + $quantity
WHERE id = (SELECT part_id FROM orders WHERE id = $order_id)`),
    fn("発注の値", `const d = msg.data;
msg.params = {
    $order_id: Number(d.order_id), $quantity: Number(d.quantity),
    $received_date: d.received_date, $receiver_id: d.employee_id,
};
return msg;`),
    sql("入荷済にする", `UPDATE orders SET status = '入荷済', received_date = $received_date,
  received_qty = $quantity, receiver_id = $receiver_id
WHERE id = $order_id`),
    fn("部品を引く値", `msg.params = { $order_id: Number(msg.data.order_id) };
return msg;`),
    sql("発注の部品", `SELECT p.* FROM orders o JOIN parts p ON p.id = o.part_id WHERE o.id = $order_id`),
    fn("履歴の値", `const d = msg.data;
msg.part = msg.payload[0];
msg.params = {
    $part_id: msg.part.id, $quantity: Number(d.quantity), $employee_id: d.employee_id,
    $note: "発注ID " + d.order_id + " 入荷", $received_date: d.received_date,
};
return msg;`),
    sql("履歴に入庫", HISTORY_SQL("入庫", "$received_date || strftime(' %H:%M', 'now', 'localtime')")),
    fn("応答", `msg.payload = {
    status: "ok", message: msg.part.name + " を " + msg.data.quantity + "個 入庫しました", stock: msg.part.stock,
};
return msg;`),
    httpRes()], 140);

  httpCatch(z, 460);
}

// ==============================================================================
// タブ5: 出庫（HTTP と MQTT で共通）
// ==============================================================================
{
  const z = tab("出庫", "M5StickC からの出庫。HTTP と MQTT のどちらから来ても『出庫処理』を呼ぶ。");

  chain(z, 40, [comment("出庫処理（link call で呼ばれる共通部分）")]);
  const [linkIn, , getPart] = chain(z, 100, [
    { type: "link in", name: "出庫処理", links: [] },
    fn("部品を引く値", `const d = msg.payload;
msg.data = {
    part_id: String(d.part_id || "").trim(),
    quantity: Number(d.quantity),
    employee_id: String(d.employee_id || ""),
    department: d.department || "",
};
msg.params = { $id: msg.data.part_id };
return msg;`),
    sql("部品1件", "SELECT * FROM parts WHERE id = $id"),
  ]);
  const check = chain(z, 160, [fn("在庫は足りる？", `const part = msg.payload[0];
const qty = msg.data.quantity;
if (!part) {
    msg.result = { status: "error", message: "部品 " + msg.data.part_id + " が見つかりません" };
    msg.code = 404;
    return [null, msg];
}
if (!(qty > 0) || part.stock < qty) {
    msg.result = { status: "error", message: "在庫不足です（現在庫: " + part.stock + ", 要求: " + qty + "）" };
    msg.code = 409;
    return [null, msg];
}
msg.part = part;
msg.params = { $id: part.id, $quantity: qty };
return [msg, null];`, 2)], 140)[0];
  getPart.wires = [[check.id]];

  const ok = chain(z, 160, [
    sql("在庫を減らす", "UPDATE parts SET stock = stock - $quantity WHERE id = $id AND stock >= $quantity"),
    fn("履歴の値", `const d = msg.data;
msg.params = { $part_id: d.part_id, $quantity: d.quantity, $employee_id: d.employee_id, $department: d.department };
return msg;`),
    sql("履歴に出庫", `INSERT INTO history (ts, kind, part_id, quantity, worker_id, worker_name, department, note)
SELECT strftime('%Y-%m-%d %H:%M', 'now', 'localtime'), '出庫', $part_id, $quantity, id, name,
  COALESCE(NULLIF($department, ''), department), ''
FROM employees WHERE id = $employee_id`),
    fn("結果を作る", `const p = msg.part;
const stock = p.stock - msg.data.quantity;
const alert = stock <= p.reorder_point;
msg.code = 200;
msg.result = {
    status: "ok",
    message: p.name + " を " + msg.data.quantity + "個 出庫しました",
    part_id: p.id, part_name: p.name, stock, reorder_point: p.reorder_point,
    alert,  // true: M5でアラート音とメッセージを出す
    alert_message: alert ? "在庫が発注点以下です。発注してください" : "",
};
return msg;`),
  ], 400);
  const [ret] = chain(z, 240, [{ type: "link out", name: "呼び出し元へ戻す", mode: "return", links: [] }], 1240);
  ok[ok.length - 1].wires = [[ret.id]];
  check.wires = [[ok[0].id], [ret.id]];

  chain(z, 320, [comment("HTTP: POST /api/checkout（M5ダミー画面から）")]);
  const linkCall = { type: "link call", name: "出庫処理を呼ぶ", links: [linkIn.id], linkType: "static", timeout: "30" };
  chain(z, 380, [httpIn("post", "/api/checkout"), { ...linkCall },
    fn("HTTPで返す", `msg.statusCode = msg.code;
msg.payload = msg.result;
return msg;`),
    httpRes()]);

  chain(z, 460, [comment("MQTT: degimono/checkout を受けて degimono/status に結果を返す")]);
  const BROKER_ID = nid();
  nodes.push({
    id: BROKER_ID, type: "mqtt-broker", name: "ラズパイのMosquitto", broker: "localhost", port: "1883",
    clientid: "", autoConnect: true, usetls: false, protocolVersion: "4", keepalive: "60", cleansession: true,
    autoUnsubscribe: true, birthTopic: "", birthQos: "0", birthPayload: "", birthMsg: {},
    closeTopic: "", closeQos: "0", closePayload: "", closeMsg: {},
    willTopic: "", willQos: "0", willPayload: "", willMsg: {}, userProps: "", sessionExpiry: "",
  });
  chain(z, 520, [
    { type: "mqtt in", name: "", topic: "degimono/checkout", qos: "0", datatype: "json", broker: BROKER_ID,
      nl: false, rap: true, rh: 0, inputs: 0 },
    { ...linkCall },
    fn("MQTTで返す", `msg.topic = "degimono/status";
msg.payload = msg.result;
return msg;`),
    { type: "mqtt out", name: "", topic: "", qos: "", retain: "", respTopic: "", contentType: "",
      userProps: "", correl: "", expiry: "", broker: BROKER_ID },
  ]);

  httpCatch(z, 600);
}

// 共通: SQLite の接続先
nodes.push({ id: DB_ID, type: "sqlitedb", db: DB_FILE, mode: "RWC" });

fs.writeFileSync(path.join(__dirname, "flows.json"), JSON.stringify(nodes, null, 2) + "\n");
console.log(`flows.json を作成しました（${nodes.length} ノード）`);

// 画面タブだけ（コンテキスト版を自作するときに読み込む）
const screenTab = nodes.find(n => n.type === "tab" && n.label === "画面").id;
const screen = nodes.filter(n => n.id === screenTab || n.z === screenTab);
fs.writeFileSync(path.join(__dirname, "flows_screen.json"), JSON.stringify(screen, null, 2) + "\n");
console.log(`flows_screen.json を作成しました（${screen.length} ノード）`);
