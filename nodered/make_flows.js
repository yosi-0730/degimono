// 在庫管理システムの Node-RED フロー（flows.json）を作るスクリプト
// 使い方: node make_flows.js  → 同じフォルダに flows.json と flows_screen.json（画面タブだけ）ができる
// ラズパイへ入れるのは node deploy.js
// データはグローバルコンテキストの "degimono" に持つ（DB は使わない）。
// settings.js の contextStorage を localfilesystem にしておくと、再起動してもデータが残る。
// 方針は「自作用の方針.md」。自作版と同時に動かすと URL が重なるので、どちらかのタブを無効にする。
//
// ノードの分け方
// - コンテキストの読み書きは change ノード（「データを読む」で msg.db に出し、「保存する」で戻す）
// - 何度も使う処理（部品に状態を付ける・履歴に残す・履歴一覧を作る）は「共通処理」タブに置き、link call で呼ぶ
// - 分岐は switch ノード、決まった形の応答やエラーは change ノード（JSONata）で作る
// - function ノードは1つの仕事だけをする

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const KEY = "degimono"; // グローバルコンテキストのキー

// ------------------------------------------------------------------------------
// ノードを作る道具
// ------------------------------------------------------------------------------
let seq = 0;
const nid = () => "dc" + (++seq).toString(16).padStart(6, "0");
const nodes = [];
const X = 190; // ノードの横の間隔

function tab(label, info = "") {
  const t = { id: nid(), type: "tab", label, disabled: false, info };
  nodes.push(t);
  return t.id;
}

// 横一列にノードを並べ、左から順につなぐ。並べたノードを返す
function chain(z, y, specs, x0 = 120) {
  const made = specs.map((s, i) => ({ id: nid(), z, x: x0 + i * X, y, wires: [], ...s }));
  for (let i = 0; i < made.length - 1; i++) {
    if (made[i].wires.length === 0) made[i].wires = [[made[i + 1].id]];
  }
  made.forEach(n => {
    if (["http response", "mqtt out", "debug", "comment", "link out"].includes(n.type)) n.wires = [];
    nodes.push(n);
  });
  return made;
}

// a の出力 port を b につなぐ
function wire(a, b, port = 0) {
  while (a.wires.length <= port) a.wires.push([]);
  a.wires[port].push(b.id);
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
const inject = (name, once, props = [{ p: "payload" }]) => ({
  type: "inject", name, props, repeat: "", crontab: "", once, onceDelay: "0.5",
  topic: "", payload: "", payloadType: "date",
});

// change ノード。set(プロパティ, 値, 値の種類)
const set = (p, to, tot = "str", pt = "msg") => ({ t: "set", p, pt, to, tot });
const change = (name, rules) => ({ type: "change", name, rules, action: "", property: "", from: "", to: "", reg: false });
const readDb = () => change("データを読む", [set("db", KEY, "global")]);
const saveDb = () => change("保存する", [set(KEY, "db", "msg", "global")]);
// エラー応答。message は JSONata の式
const errorRes = (name, code, message) => change(name, [
  set("statusCode", String(code), "num"),
  set("payload", `{ "status": "error", "message": ${message} }`, "jsonata"),
]);

// switch ノード。rules の数だけ出力ができる
const sw = (name, property, rules) => ({
  type: "switch", name, property, propertyType: "msg", rules, checkall: "false", repair: false, outputs: rules.length,
});
const isNull = { t: "null" };
const otherwise = { t: "else" };
const jsonataRule = v => ({ t: "jsonata_exp", v, vt: "jsonata" });

// link call（共通処理を呼ぶ）
const call = (name, linkIn) => ({ type: "link call", name, links: [linkIn.id], linkType: "static", timeout: "30" });
const ret = () => ({ type: "link out", name: "呼び出し元へ戻す", mode: "return", links: [] });

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

const DEPARTMENTS = ["製造部", "開発部", "資材課", "品質管理部", "設備保全課"];
const LOCATIONS = ["A", "B", "C", "D", "E", "F", "部品棚"];

// ==============================================================================
// タブ1: 画面
// ==============================================================================
{
  const z = tab("画面（完成品）", "元の index.html / m5_dummy.html をそのまま返す。");
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
// タブ2: 共通処理（link call で呼ぶ）
// ==============================================================================
let PART_STATE, ADD_HISTORY, HISTORY_LIST;
{
  const z = tab("共通処理（完成品）", "ほかのタブから link call で呼ぶ処理。どれも msg.db（データを読むで出したもの）を使う。");

  chain(z, 40, [comment("部品に状態を付ける: msg.payload（部品1件か配列）に below_point, waiting_order, state を足す")]);
  [PART_STATE] = chain(z, 100, [
    { type: "link in", name: "部品に状態を付ける", links: [] },
    fn("状態を付ける", `const db = msg.db;
function view(p) {
    const waiting = db.orders.filter(o => o.part_id === p.id && o.status === "入荷待ち")
        .sort((a, b) => a.id - b.id)[0];
    const below = p.stock <= p.reorder_point;
    return {
        ...p,
        below_point: below,
        waiting_order: waiting ? {
            id: waiting.id, part_id: waiting.part_id, quantity: waiting.quantity, orderer_id: waiting.orderer_id,
            ordered_date: waiting.ordered_date, expected_date: waiting.expected_date, status: waiting.status,
        } : null,
        state: waiting ? "入荷待ち" : (below ? "要発注" : "発注不要"),
    };
}
msg.payload = Array.isArray(msg.payload) ? msg.payload.map(view) : view(msg.payload);
return msg;`),
    ret(),
  ]);

  chain(z, 180, [comment("履歴に残す: msg.history（kind, part_id, quantity, employee_id, note, department, date）を履歴に足す",
    "作業者名と部署は従業員から引く。従業員がいなければ残さない。\n" +
    "日時は今。date（YYYY-MM-DD）があれば、その日付に今の時刻を付ける。")]);
  [ADD_HISTORY] = chain(z, 240, [
    { type: "link in", name: "履歴に残す", links: [] },
    fn("履歴に足す", `const db = msg.db;
const h = msg.history;
const e = db.employees.find(e => e.id === h.employee_id);
if (!e) return msg;

const d = new Date();
const p = n => String(n).padStart(2, "0");
const date = h.date || d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());

db.history.push({
    id: ++db.seq.history, ts: date + " " + p(d.getHours()) + ":" + p(d.getMinutes()),
    kind: h.kind, part_id: h.part_id, quantity: h.quantity,
    worker_id: e.id, worker_name: e.name, department: h.department || e.department, note: h.note || "",
});
return msg;`),
    ret(),
  ]);

  chain(z, 320, [comment("履歴一覧を作る: 履歴を新しい順に並べ、品名を付けて msg.payload に入れる")]);
  [HISTORY_LIST] = chain(z, 380, [
    { type: "link in", name: "履歴一覧を作る", links: [] },
    fn("新しい順に品名を付ける", `const db = msg.db;
msg.payload = db.history
    .slice().sort((a, b) => b.ts.localeCompare(a.ts) || b.id - a.id)
    .map(h => {
        const p = db.parts.find(p => p.id === h.part_id);
        return { ...h, part_name: p ? p.name : null };
    });
return msg;`),
    ret(),
  ]);
}

// ==============================================================================
// タブ3: データ準備（起動時・初期化ボタン）
// ==============================================================================
{
  const z = tab("データ準備（完成品）", "起動時にデータがなければデモデータを入れる。「デモデータに戻す」で全部消して入れ直す。");
  chain(z, 40, [comment(`データはグローバルコンテキストの "${KEY}"（サイドバーの「コンテキストデータ」で見られる）`)]);

  const [, , has] = chain(z, 100, [inject("起動時に1回", true), readDb(),
    sw("データはある？", "db", [isNull, otherwise])]);
  const [make, , done] = chain(z, 100, [
    fn("デモデータを作る", `// (社員ID, 氏名, よみ, 部署)
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

const db = {
    employees: EMPLOYEES.map(([id, name, kana, department]) => ({ id, name, kana, department })),
    parts: PARTS.map(([id, name, location, stock, reorder_point, departments]) =>
        ({ id, name, location, stock, reorder_point, departments })),
    orders: [],
    history: [],
    seq: { order: 0, history: 0 },
};
// 発注と、その発注の履歴
for (const [part_id, quantity, orderer_id, ordered_date, expected_date] of ORDERS) {
    db.orders.push({
        id: ++db.seq.order, part_id, quantity, orderer_id, ordered_date, expected_date,
        status: "入荷待ち", received_date: null, received_qty: null, receiver_id: null,
    });
    const e = db.employees.find(e => e.id === orderer_id);
    db.history.push({
        id: ++db.seq.history, ts: ordered_date + " 10:00", kind: "発注", part_id, quantity,
        worker_id: e.id, worker_name: e.name, department: e.department, note: "入荷予定日 " + expected_date,
    });
}
msg.db = db;
return msg;`),
    saveDb(),
    change("完了", [set("payload", "デモデータを入れました")]),
    debug("データ準備"),
  ], 120 + 3 * X);
  wire(has, make, 0);
  const [keep] = chain(z, 160, [change("そのまま使う", [set("payload", "データあり（そのまま使う）")])], 120 + 3 * X);
  wire(has, keep, 1);
  keep.wires = [[done.wires[0][0]]];

  // 手で押す初期化ボタン
  const [reset] = chain(z, 220, [inject("デモデータに戻す", false)]);
  wire(reset, make);
}

// ==============================================================================
// タブ4: 参照API
// ==============================================================================
{
  const z = tab("参照API（完成品）", "画面が一覧や詳細を取りに来る GET の API。");
  chain(z, 40, [comment("GET の API（画面からの読み込み）")]);

  chain(z, 100, [httpIn("get", "/api/employees"), readDb(),
    fn("よみ順に並べて部署と返す", `const employees = msg.db.employees
    .slice().sort((a, b) => a.kana.localeCompare(b.kana, "ja"))
    .map(e => ({ id: e.id, name: e.name, department: e.department }));
msg.payload = { departments: ${JSON.stringify(DEPARTMENTS)}, employees };
return msg;`),
    httpRes()]);

  chain(z, 160, [httpIn("get", "/api/locations"),
    change("保管場所一覧", [set("payload", JSON.stringify(LOCATIONS), "json")]),
    httpRes()]);

  chain(z, 220, [httpIn("get", "/api/parts"), readDb(),
    fn("品番・品名で探す", `const q = (msg.req.query.q || "").trim().toLowerCase();
msg.payload = msg.db.parts
    .filter(p => p.id.toLowerCase().includes(q) || p.name.toLowerCase().includes(q))
    .sort((a, b) => a.id.localeCompare(b.id));
return msg;`),
    call("部品に状態を付ける", PART_STATE),
    httpRes()]);

  const [, , , found] = chain(z, 280, [httpIn("get", "/api/parts/:id"), readDb(),
    fn("品番で1件探す", `msg.payload = msg.db.parts.find(p => p.id === msg.req.params.id) || null;
return msg;`),
    sw("見つかった？", "payload", [isNull, otherwise])]);
  const [res1] = chain(z, 300, [call("部品に状態を付ける", PART_STATE), httpRes()], 120 + 4 * X);
  const [notFound] = chain(z, 340, [errorRes("部品なし", 404, `"部品が見つかりません"`)], 120 + 4 * X);
  found.wires = [[notFound.id], [res1.id]];
  notFound.wires = [[res1.wires[0][0]]];

  chain(z, 400, [httpIn("get", "/api/orders/unordered"), readDb(),
    change("全部品", [set("payload", "db.parts", "msg")]),
    call("部品に状態を付ける", PART_STATE),
    fn("未発注だけ・要発注を先頭", `msg.payload = msg.payload
    .filter(p => p.waiting_order === null)
    .sort((a, b) => (b.below_point - a.below_point) || a.id.localeCompare(b.id));
return msg;`),
    httpRes()]);

  chain(z, 460, [httpIn("get", "/api/orders/waiting"), readDb(),
    fn("入荷待ちに品名・発注者を付ける", `const db = msg.db;
const list = [];
for (const o of db.orders) {
    if (o.status !== "入荷待ち") continue;
    const p = db.parts.find(p => p.id === o.part_id);
    const e = db.employees.find(e => e.id === o.orderer_id);
    if (!p || !e) continue;  // 部品か発注者がなければ出さない
    list.push({ ...o, part_name: p.name, location: p.location, stock: p.stock, orderer_name: e.name });
}
msg.payload = list.sort((a, b) => a.expected_date.localeCompare(b.expected_date) || a.id - b.id);
return msg;`),
    httpRes()]);

  chain(z, 520, [httpIn("get", "/api/history"), readDb(),
    call("履歴一覧を作る", HISTORY_LIST),
    fn("新しい200件", `msg.payload = msg.payload.slice(0, 200);
return msg;`),
    httpRes()]);

  chain(z, 580, [httpIn("get", "/download/history.csv"), readDb(),
    call("履歴一覧を作る", HISTORY_LIST),
    fn("CSVにする", `const cell = v => {
    const s = String(v ?? "");
    return /[",\\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
// 変動数量は在庫の増減（出庫はマイナス、発注は在庫が動かないので0）。発注の数は「発注数」の列に出す
const change = r => r.kind === "出庫" ? -r.quantity : (r.kind === "発注" ? 0 : r.quantity);
const lines = [["日時", "種別", "品番", "品名", "変動数量", "発注数", "作業者名", "使用部署", "備考"]];
for (const r of msg.payload) {
    lines.push([r.ts, r.kind, r.part_id, r.part_name, change(r), r.kind === "発注" ? r.quantity : "",
        r.worker_name, r.department, r.note]);
}
// Excel で文字化けしないよう BOM を付ける
msg.payload = "\\ufeff" + lines.map(l => l.map(cell).join(",")).join("\\r\\n") + "\\r\\n";
msg.headers = {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": "attachment; filename=history.csv",
};
return msg;`),
    httpRes()]);

  httpCatch(z, 660);
}

// ==============================================================================
// タブ5: 登録API（部品登録・発注・入庫）
// ==============================================================================
{
  const z = tab("登録API（完成品）", "画面からの登録（POST）。入力チェックは最小限。");

  // ---- 部品登録 ----
  chain(z, 40, [comment("部品登録 POST /api/parts")]);
  const [, , , dup] = chain(z, 100, [httpIn("post", "/api/parts"), readDb(),
    fn("部品の値を読む", `const d = msg.payload;
msg.part = {
    id: String(d.part_id || "").trim(),
    name: String(d.name || "").trim(),
    location: d.location || "",
    stock: Number(d.stock) || 0,
    reorder_point: Number(d.reorder_point) || 0,
    departments: d.departments || "",
};
msg.employee_id = d.employee_id;
return msg;`),
    sw("登録済み？", "part", [jsonataRule("part.id in db.parts.id"), otherwise])]);
  const add = chain(z, 100, [
    fn("部品を足す", `msg.db.parts.push(msg.part);
return msg;`),
    change("履歴の値", [set("history", `{
  "kind": "登録", "part_id": part.id, "quantity": part.stock, "employee_id": employee_id,
  "note": "新規部品登録（初期在庫 " & part.stock & "、発注点 " & part.reorder_point & "）"
}`, "jsonata")]),
    call("履歴に残す", ADD_HISTORY),
    saveDb(),
    change("登録した部品", [set("payload", "part", "msg")]),
    call("部品に状態を付ける", PART_STATE),
    change("応答", [
      set("statusCode", "201", "num"),
      set("payload", `{ "status": "ok", "message": payload.name & "（" & payload.id & "）を登録しました", "part": payload }`, "jsonata"),
    ]),
    httpRes(),
  ], 120 + 4 * X);
  const [dupErr] = chain(z, 160, [errorRes("登録済み", 409, `"品番 " & part.id & " は登録済みです"`)], 120 + 4 * X);
  dup.wires = [[dupErr.id], [add[0].id]];
  dupErr.wires = [[add[add.length - 1].id]];

  // ---- 発注 ----
  chain(z, 240, [comment("発注結果の登録 POST /api/orders")]);
  chain(z, 300, [httpIn("post", "/api/orders"), readDb(),
    fn("発注を足す", `const d = msg.payload;
const db = msg.db;
db.orders.push({
    id: ++db.seq.order, part_id: d.part_id, quantity: Number(d.quantity), orderer_id: d.employee_id,
    ordered_date: d.ordered_date, expected_date: d.expected_date,
    status: "入荷待ち", received_date: null, received_qty: null, receiver_id: null,
});
return msg;`),
    change("履歴の値", [set("history", `{
  "kind": "発注", "part_id": payload.part_id, "quantity": $number(payload.quantity),
  "employee_id": payload.employee_id, "note": "入荷予定日 " & payload.expected_date
}`, "jsonata")]),
    call("履歴に残す", ADD_HISTORY),
    saveDb(),
    change("応答", [set("payload", JSON.stringify({ status: "ok", message: "発注結果を保存しました（入荷待ちへ移動）" }), "json")]),
    httpRes()]);

  // ---- 入庫 ----
  chain(z, 380, [comment("入庫登録 POST /api/checkin（在庫を足す → 発注を入荷済に → 履歴）")]);
  const [, , , foundOrder] = chain(z, 440, [httpIn("post", "/api/checkin"), readDb(),
    fn("発注と部品を探す", `const db = msg.db;
msg.order = db.orders.find(o => o.id === Number(msg.payload.order_id));
msg.part = (msg.order && db.parts.find(p => p.id === msg.order.part_id)) || null;
return msg;`),
    sw("見つかった？", "part", [isNull, otherwise])]);
  const checkin = chain(z, 440, [
    fn("在庫を足して入荷済にする", `const d = msg.payload;
const qty = Number(d.quantity);
msg.part.stock += qty;
Object.assign(msg.order, { status: "入荷済", received_date: d.received_date, received_qty: qty, receiver_id: d.employee_id });
return msg;`),
    change("履歴の値", [set("history", `{
  "kind": "入庫", "part_id": part.id, "quantity": $number(payload.quantity), "employee_id": payload.employee_id,
  "date": payload.received_date, "note": "発注ID " & payload.order_id & " 入荷"
}`, "jsonata")]),
    call("履歴に残す", ADD_HISTORY),
    saveDb(),
    change("応答", [set("payload",
      `{ "status": "ok", "message": part.name & " を " & payload.quantity & "個 入庫しました", "stock": part.stock }`, "jsonata")]),
    httpRes(),
  ], 120 + 4 * X);
  const [noOrder] = chain(z, 500, [errorRes("発注なし", 404, `"発注ID " & payload.order_id & " が見つかりません"`)], 120 + 4 * X);
  foundOrder.wires = [[noOrder.id], [checkin[0].id]];
  noOrder.wires = [[checkin[checkin.length - 1].id]];

  httpCatch(z, 580);
}

// ==============================================================================
// タブ6: 出庫（HTTP と MQTT で共通）
// ==============================================================================
{
  const z = tab("出庫（完成品）", "M5StickC からの出庫。HTTP と MQTT のどちらから来ても同じ流れで処理し、最後に返し先を分ける。");

  chain(z, 40, [comment("HTTP: POST /api/checkout（M5ダミー画面から）／ MQTT: degimono/checkout → degimono/status")]);

  const BROKER_ID = nid();
  nodes.push({
    id: BROKER_ID, type: "mqtt-broker", name: "ラズパイのMosquitto（完成品）", broker: "localhost", port: "1883",
    clientid: "", autoConnect: true, usetls: false, protocolVersion: "4", keepalive: "60", cleansession: true,
    autoUnsubscribe: true, birthTopic: "", birthQos: "0", birthPayload: "", birthMsg: {},
    closeTopic: "", closeQos: "0", closePayload: "", closeMsg: {},
    willTopic: "", willQos: "0", willPayload: "", willMsg: {}, userProps: "", sessionExpiry: "",
  });

  // 受け口（HTTP と MQTT）→ 出庫の値を読む
  const [h] = chain(z, 140, [httpIn("post", "/api/checkout")]);
  const [m] = chain(z, 200, [{ type: "mqtt in", name: "", topic: "degimono/checkout", qos: "0", datatype: "json",
    broker: BROKER_ID, nl: false, rap: true, rh: 0, inputs: 0 }]);
  const [read, , , judge] = chain(z, 170, [
    fn("出庫の値を読む", `const d = msg.payload;
msg.data = {
    part_id: String(d.part_id || "").trim(),
    quantity: Number(d.quantity) || 0,
    employee_id: String(d.employee_id || "").trim(),
    user_name: String(d.user_name || "").trim(),  // QR には社員名だけが入るので、名前でも探す
    department: d.department || "",
};
return msg;`),
    readDb(),
    fn("従業員と部品を探す", `const db = msg.db;
const d = msg.data;
// 社員IDがあれば社員IDで、なければ社員名で探す
msg.employee = (d.employee_id ? db.employees.find(e => e.id === d.employee_id)
    : db.employees.find(e => e.name === d.user_name)) || null;
msg.part = db.parts.find(p => p.id === d.part_id) || null;
return msg;`),
    sw("出庫できる？", "part", [
      jsonataRule(`data.part_id = "" or data.quantity <= 0`),
      jsonataRule("employee = null"),
      jsonataRule("part = null"),
      jsonataRule("part.stock < data.quantity"),
      otherwise,
    ]),
  ], 120 + X);
  wire(h, read);
  wire(m, read);

  // 出庫できるとき
  const ok = chain(z, 170, [
    fn("在庫を減らす", `msg.part.stock -= msg.data.quantity;
return msg;`),
    change("履歴の値", [set("history", `{
  "kind": "出庫", "part_id": part.id, "quantity": data.quantity,
  "employee_id": employee.id, "department": data.department
}`, "jsonata")]),
    call("履歴に残す", ADD_HISTORY),
    saveDb(),
    fn("結果を作る", `const p = msg.part;
const alert = p.stock <= p.reorder_point;
msg.statusCode = 200;
msg.payload = {
    status: "ok",
    message: p.name + " を " + msg.data.quantity + "個 出庫しました",
    part_id: p.id, part_name: p.name, stock: p.stock, reorder_point: p.reorder_point,
    alert,  // true: M5でアラート音とメッセージを出す
    alert_message: alert ? "在庫が発注点以下です。発注してください" : "",
};
return msg;`),
  ], 120 + 5 * X);

  // 出庫できないとき
  const [badInput] = chain(z, 240, [errorRes("入力の誤り", 400, `"part_id と 1以上の quantity が必要です"`)], 120 + 5 * X);
  const [noEmployee] = chain(z, 300, [errorRes("従業員なし", 404, `"従業員が見つかりません"`)], 120 + 5 * X);
  const [noPart] = chain(z, 360, [errorRes("部品なし", 404, `"部品 " & data.part_id & " が見つかりません"`)], 120 + 5 * X);
  const [short] = chain(z, 420, [errorRes("在庫不足", 409,
    `"在庫不足です（現在庫: " & part.stock & ", 要求: " & data.quantity & "）"`)], 120 + 5 * X);
  judge.wires = [[badInput.id], [noEmployee.id], [noPart.id], [short.id], [ok[0].id]];

  // 返し先を分ける（msg.res があれば HTTP から来たもの）
  const [where] = chain(z, 240, [sw("返し先は？", "res", [{ t: "nnull" }, otherwise])], 120 + 10 * X);
  const [resHttp] = chain(z, 220, [httpRes()], 120 + 11 * X);
  const [toMqtt, mqttOut] = chain(z, 280, [
    change("MQTTの宛先", [set("topic", "degimono/status")]),
    { type: "mqtt out", name: "", topic: "", qos: "", retain: "", respTopic: "", contentType: "",
      userProps: "", correl: "", expiry: "", broker: BROKER_ID },
  ], 120 + 11 * X);
  for (const n of [ok[ok.length - 1], badInput, noEmployee, noPart, short]) n.wires = [[where.id]];
  where.wires = [[resHttp.id], [toMqtt.id]];

  // 発注点以下になったら、M5 に表示する文を degimono/alert に送る（HTTP・MQTT どちらの出庫でも）
  chain(z, 500, [comment("発注点以下の通知: 出庫後の在庫が発注点以下なら degimono/alert と WebSocket /ws/alert に表示用の文を送る",
    "text を M5 の画面にそのまま出す（行は \\n で区切る）。\n" +
    "すでに入荷待ちの発注があるときは「発注してください」ではなく入荷予定日を出す。\n" +
    "WebSocket はブラウザの M5 ダミー画面（/m5-dummy）用。")], 120 + 5 * X);
  const [needAlert, makeAlert] = chain(z, 560, [
    sw("発注点以下？", "payload.alert", [{ t: "true" }]),
    fn("通知文を作る", `const p = msg.part;
const waiting = msg.db.orders.filter(o => o.part_id === p.id && o.status === "入荷待ち")
    .sort((a, b) => a.id - b.id)[0];
const due = waiting ? waiting.expected_date.slice(5).replace("-", "/") : "";  // 2026-10-16 → 10/16

msg.payload = {
    part_id: p.id,
    part_name: p.name,
    stock: p.stock,
    reorder_point: p.reorder_point,
    ordered: !!waiting,
    text: [
        "【発注点以下】",
        p.name,
        "品番 " + p.id,
        "在庫 " + p.stock + " / 発注点 " + p.reorder_point,
        waiting ? "発注済み 入荷予定 " + due : "発注してください",
    ].join("\\n"),
};
return msg;`),
    change("宛先", [set("topic", "degimono/alert")]),
    { type: "mqtt out", name: "", topic: "", qos: "1", retain: "false", respTopic: "", contentType: "",
      userProps: "", correl: "", expiry: "", broker: BROKER_ID },
  ], 120 + 5 * X);
  ok[ok.length - 1].wires[0].push(needAlert.id);

  // ダミー画面へは WebSocket で同じ通知を流す
  const WS_ID = nid();
  nodes.push({ id: WS_ID, type: "websocket-listener", path: "/ws/alert", wholemsg: "false" });
  const [wsOut] = chain(z, 620, [{ type: "websocket out", name: "ダミー画面へ", server: WS_ID, client: "" }], 120 + 7 * X);
  wire(makeAlert, wsOut);

  httpCatch(z, 700);
}

fs.writeFileSync(path.join(__dirname, "flows.json"), JSON.stringify(nodes, null, 2) + "\n");
console.log(`flows.json を作成しました（${nodes.length} ノード）`);

// 画面タブだけ（自作版を作るときに読み込む）。完成品と一緒に入れても重ならないよう ID の頭を ds に付け替える
const screenTab = nodes.find(n => n.type === "tab" && n.label.startsWith("画面"));
const newId = id => id.replace(/^dc/, "ds");
const screen = nodes.filter(n => n === screenTab || n.z === screenTab.id).map(n => {
  const c = JSON.parse(JSON.stringify(n));
  c.id = newId(c.id);
  if (c.z) c.z = newId(c.z);
  if (c.type === "tab") c.label = "画面";
  if (c.wires) c.wires = c.wires.map(port => port.map(newId));
  return c;
});
fs.writeFileSync(path.join(__dirname, "flows_screen.json"), JSON.stringify(screen, null, 2) + "\n");
console.log(`flows_screen.json を作成しました（${screen.length} ノード）`);
