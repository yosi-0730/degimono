/**
 * 在庫管理システム - フロントエンドスクリプト
 * image.png 完全再現 ＆ 入出庫共通化（部署 ➜ ソート従業員）
 */

// ① 部品在庫テーブル（Master）初期ダミーデータ
const INITIAL_PARTS = [
  {
    part_id: "AB-1234",
    name: "近接センサー",
    location: "２Ｆー②",
    stock: 2,           // 発注点(2)以下 -> image.png の通り「発注してください！」警告表示！
    reorder_point: 2,
    departments: "T2、T4",
    order_status: "未発注"
  },
  {
    part_id: "CD-5678",
    name: "マイクロスイッチ",
    location: "２Ｆー①",
    stock: 1,           // 発注点(5)以下だが発注済のテスト用
    reorder_point: 5,
    departments: "T1、T2",
    order_status: "発注済"
  },
  {
    part_id: "EF-9012",
    name: "ステッピングモーター",
    location: "１ＦーＡ",
    stock: 12,
    reorder_point: 3,
    departments: "T3",
    order_status: "未発注"
  },
  {
    part_id: "GH-3456",
    name: "リニアガイドレール",
    location: "１ＦーＢ",
    stock: 4,
    reorder_point: 4,
    departments: "T2、T4",
    order_status: "未発注"
  },
  {
    part_id: "JK-7890",
    name: "電磁開閉器",
    location: "３ＦーＣ",
    stock: 8,
    reorder_point: 2,
    departments: "T1",
    order_status: "未発注"
  }
];

// ② 部署・従業員マスター（部署選択後にソートされた従業員を選ぶ）
const DEPARTMENT_EMPLOYEES = {
  "製造部": [
    "相田健司",
    "佐々木徹",
    "田中次郎",
    "山田太郎",
    "渡辺健一"
  ],
  "開発部": [
    "木村拓哉",
    "佐藤花子",
    "高橋涼介",
    "本田翼"
  ],
  "資材課": [
    "斉藤和夫",
    "鈴木一郎",
    "中村誠"
  ],
  "品質管理部": [
    "伊藤美咲",
    "加藤進",
    "吉田裕子"
  ],
  "設備保全課": [
    "小林正雄",
    "松本大樹"
  ]
};

// ③ 入出庫履歴ログ（History）初期ダミーデータ
const INITIAL_HISTORY = [
  {
    datetime: "2026-10-14 13:45",
    type: "出庫",
    part_id: "AB-1234",
    part_name: "近接センサー",
    quantity: 1,
    user_name: "田中次郎",
    department: "製造部"
  },
  {
    datetime: "2026-10-14 13:00",
    type: "出庫",
    part_id: "CD-5678",
    part_name: "マイクロスイッチ",
    quantity: 3,
    user_name: "佐藤花子",
    department: "開発部"
  },
  {
    datetime: "2026-10-14 11:30",
    type: "入庫",
    part_id: "EF-9012",
    part_name: "ステッピングモーター",
    quantity: 10,
    user_name: "鈴木一郎",
    department: "資材課"
  },
  {
    datetime: "2026-10-14 10:15",
    type: "出庫",
    part_id: "AB-1234",
    part_name: "近接センサー",
    quantity: 2,
    user_name: "山田太郎",
    department: "製造部"
  }
];

// アプリ状態
let parts = JSON.parse(JSON.stringify(INITIAL_PARTS));
let historyLogs = JSON.parse(JSON.stringify(INITIAL_HISTORY));
let selectedPartId = "AB-1234"; // image.png の初期表示部品
let currentOpsType = "in";      // "in" (入庫) または "out" (出庫)
const isHttpServer = window.location.protocol.startsWith("http");

// 初期化
document.addEventListener("DOMContentLoaded", async () => {
  setupDepartmentEmployeeSelects();
  setupEventListeners();

  if (isHttpServer) {
    try {
      await fetchServerData();
    } catch (e) {
      console.warn("サーバーAPI接続不可。ローカルメモリデータを使用します。", e);
    }
  }

  updateScreen();
});

// 部署・従業員の連動プルダウンのセットアップ
function setupDepartmentEmployeeSelects() {
  const deptSelect = document.getElementById("deptSelect");
  const workerSelect = document.getElementById("workerSelect");
  if (!deptSelect || !workerSelect) return;

  deptSelect.innerHTML = Object.keys(DEPARTMENT_EMPLOYEES).map(dept => `
    <option value="${dept}">${dept}</option>
  `).join("");

  deptSelect.addEventListener("change", () => {
    updateWorkerDropdown(deptSelect.value);
  });

  updateWorkerDropdown(deptSelect.value);
}

// 選択された部署に基づいて五十音順ソートされた従業員プルダウンを更新
function updateWorkerDropdown(selectedDept) {
  const workerSelect = document.getElementById("workerSelect");
  if (!workerSelect) return;

  const employees = DEPARTMENT_EMPLOYEES[selectedDept] || [];
  const sortedEmployees = [...employees].sort((a, b) => a.localeCompare(b, "ja"));

  workerSelect.innerHTML = sortedEmployees.map(emp => `
    <option value="${emp}">${emp}</option>
  `).join("");
}

// サーバーからデータ取得
async function fetchServerData() {
  const [resParts, resHistory] = await Promise.all([
    fetch("/api/parts"),
    fetch("/api/history")
  ]);
  if (resParts.ok && resHistory.ok) {
    parts = await resParts.json();
    historyLogs = await resHistory.json();
  }
}

// 画面全体の描画更新
function updateScreen() {
  renderPartDetails();
  renderAlertBanner();
}

// 半角数値を全角数値に変換（image.pngの「２」を表現）
function toZenkakuNum(num) {
  return String(num).replace(/[0-9]/g, s => String.fromCharCode(s.charCodeAt(0) + 0xFEE0));
}

// 部品詳細の描画 (image.png 右側パネル)
function renderPartDetails() {
  const part = parts.find(p => p.part_id === selectedPartId) || parts[0];
  if (!part) return;

  document.getElementById("dispPartName").textContent = part.name;
  document.getElementById("dispPartId").textContent = part.part_id;
  document.getElementById("dispPartLocation").textContent = part.location;
  document.getElementById("dispPartStock").textContent = toZenkakuNum(part.stock);
  document.getElementById("dispPartReorder").textContent = toZenkakuNum(part.reorder_point);
  document.getElementById("dispPartDepts").textContent = part.departments;

  updateExecuteButtonText(part);
}

// 警告バナー描画 (image.png 右下: 発注してください！)
function renderAlertBanner() {
  const part = parts.find(p => p.part_id === selectedPartId) || parts[0];
  const banner = document.getElementById("alertBanner");
  if (!banner || !part) return;

  const isLowStock = part.stock <= part.reorder_point;

  if (isLowStock && part.order_status === "未発注") {
    // 警告状態 (image.png の通り: 赤背景・黒文字「発注してください！」)
    banner.className = "alert-banner-box";
    banner.textContent = "発注してください！";
    banner.title = "クリックで発注済みに切り替えます";
    banner.onclick = () => toggleOrderStatus(part.part_id);
    banner.style.display = "block";
  } else if (part.order_status === "発注済") {
    banner.className = "alert-banner-box ordered-state";
    banner.textContent = "発注済（クリックで未発注に戻す）";
    banner.title = "クリックで未発注に戻します";
    banner.onclick = () => toggleOrderStatus(part.part_id);
    banner.style.display = "block";
  } else {
    banner.className = "alert-banner-box safe-state";
    banner.textContent = "在庫適正（発注不要）";
    banner.title = "";
    banner.onclick = null;
    banner.style.display = "block";
  }
}

// 部品切り替え
function selectPart(partId) {
  selectedPartId = partId;
  const searchInput = document.getElementById("searchInput");
  if (searchInput) searchInput.value = partId;
  updateScreen();
}

// 発注状態トグル (仕様書要件)
async function toggleOrderStatus(partId) {
  const part = parts.find(p => p.part_id === partId);
  if (!part) return;

  const targetStatus = part.order_status === "未発注" ? "発注済" : "未発注";

  if (isHttpServer) {
    try {
      await fetch(`/api/parts/${partId}/order-status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order_status: targetStatus })
      });
    } catch (e) {
      console.warn("API送信失敗。ローカル状態のみ更新します。", e);
    }
  }

  part.order_status = targetStatus;

  if (targetStatus === "発注済") {
    showToast(`【${part.name}】を発注済みに更新しました。`);
  } else {
    showToast(`【${part.name}】を発注状態を未発注に戻しました。`);
  }

  updateScreen();
}

// 共通入出庫の種別切替 (入庫 / 出庫)
function setOpsType(type) {
  currentOpsType = type;
  document.getElementById("btnTypeIn").classList.toggle("active", type === "in");
  document.getElementById("btnTypeOut").classList.toggle("active", type === "out");

  const execBtn = document.getElementById("btnExecuteOps");
  execBtn.className = `btn-execute ${type === 'in' ? 'in-style' : 'out-style'}`;
  
  const part = parts.find(p => p.part_id === selectedPartId) || parts[0];
  updateExecuteButtonText(part);
}

// 実行ボタンテキスト更新
function updateExecuteButtonText(part) {
  const execBtn = document.getElementById("btnExecuteOps");
  if (!execBtn || !part) return;

  if (currentOpsType === "in") {
    execBtn.textContent = `${part.name} を 入庫する (＋)`;
  } else {
    execBtn.textContent = `${part.name} を 出庫する (−)`;
  }
}

// 数量ステップ (+ / -)
function stepQty(delta) {
  const qtyInput = document.getElementById("opsQty");
  if (!qtyInput) return;
  let val = parseInt(qtyInput.value, 10) || 1;
  val = Math.max(1, val + delta);
  qtyInput.value = val;
}

// 共通入出庫の実行処理
async function handleExecuteInventoryOps() {
  const part = parts.find(p => p.part_id === selectedPartId);
  if (!part) return;

  const qty = parseInt(document.getElementById("opsQty").value, 10);
  const dept = document.getElementById("deptSelect")?.value || "製造部";
  const workerName = document.getElementById("workerSelect")?.value || "担当者";

  if (isNaN(qty) || qty <= 0) {
    showToast("1以上の数量を入力してください");
    return;
  }

  if (currentOpsType === "in") {
    // 入庫処理
    if (isHttpServer) {
      try {
        const res = await fetch("/api/checkin", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            part_id: part.part_id,
            quantity: qty,
            user_name: workerName
          })
        });
        if (res.ok) {
          await fetchServerData();
          updateScreen();
          showToast(`【入庫】${workerName}（${dept}）が ${qty}個 入庫しました。(新在庫: ${part.stock}個)`);
          return;
        }
      } catch (e) {
        console.warn("API送信失敗。ローカル状態のみ更新します。", e);
      }
    }

    part.stock += qty;
    part.order_status = "未発注";

    const dateStr = formatDateTime(new Date());
    historyLogs.unshift({
      datetime: dateStr,
      type: "入庫",
      part_id: part.part_id,
      part_name: part.name,
      quantity: qty,
      user_name: workerName,
      department: dept
    });

    updateScreen();
    showToast(`【入庫】${workerName}（${dept}）が ${qty}個 入庫しました。(新在庫: ${part.stock}個)`);

  } else {
    // 出庫処理
    if (part.stock < qty) {
      showToast(`⚠️ 在庫が不足しています！(現在庫: ${part.stock}個、要求: ${qty}個)`);
      return;
    }

    if (isHttpServer) {
      try {
        const res = await fetch("/api/checkout", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            part_id: part.part_id,
            quantity: qty,
            user_name: workerName,
            department: dept
          })
        });
        if (res.ok) {
          await fetchServerData();
          updateScreen();
          showToast(`【出庫】${workerName}（${dept}）が ${qty}個 出庫しました。(残: ${part.stock}個)`);
          return;
        }
      } catch (e) {
        console.warn("API送信失敗。ローカル状態のみ更新します。", e);
      }
    }

    part.stock -= qty;

    const dateStr = formatDateTime(new Date());
    historyLogs.unshift({
      datetime: dateStr,
      type: "出庫",
      part_id: part.part_id,
      part_name: part.name,
      quantity: qty,
      user_name: workerName,
      department: dept
    });

    updateScreen();
    showToast(`【出庫】${workerName}（${dept}）が ${qty}個 出庫しました。(残: ${part.stock}個)`);
  }
}

// 検索ボタンクリックまたはEnterキー
function handleSearch() {
  const query = (document.getElementById("searchInput")?.value || "").trim().toLowerCase();
  if (!query) return;

  const found = parts.find(p => 
    p.part_id.toLowerCase().includes(query) ||
    p.name.toLowerCase().includes(query) ||
    p.location.toLowerCase().includes(query) ||
    p.departments.toLowerCase().includes(query)
  );

  if (found) {
    selectPart(found.part_id);
    showToast(`【${found.name}】を表示しました`);
  } else {
    showToast(`「${query}」に一致する部品は見つかりませんでした`);
  }
}

// 履歴CSVダウンロード (仕様書 3-④ GET /download/history.csv)
function exportCsv() {
  if (isHttpServer) {
    window.location.href = "/download/history.csv";
    showToast("入出庫履歴CSVをダウンロードしています...");
    return;
  }

  // スタンドアロン動作時 (ブラウザ内生成)
  const headers = ["日時", "種別", "品番", "品名", "変動数量", "作業者名", "使用部署"];
  const rows = historyLogs.map(log => [
    `"${log.datetime}"`,
    `"${log.type}"`,
    `"${log.part_id}"`,
    `"${log.part_name || ''}"`,
    log.quantity,
    `"${log.user_name}"`,
    `"${log.department || ''}"`
  ]);

  const csvContent = [headers.join(","), ...rows.map(r => r.join(","))].join("\r\n");
  const bom = new Uint8Array([0xEF, 0xBB, 0xBF]); // UTF-8 BOM
  const blob = new Blob([bom, csvContent], { type: "text/csv;charset=utf-8;" });
  
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.setAttribute("href", url);
  link.setAttribute("download", `history_${new Date().toISOString().slice(0, 10)}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);

  showToast("入出庫履歴CSVをダウンロードしました");
}

// 日時フォーマット YYYY-MM-DD HH:mm
function formatDateTime(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${d} ${h}:${min}`;
}

// トースト通知
function showToast(message) {
  let toast = document.getElementById("toastNotice");
  if (!toast) return;

  toast.textContent = message;
  toast.style.display = "block";

  clearTimeout(toast._timeout);
  toast._timeout = setTimeout(() => {
    toast.style.display = "none";
  }, 2500);
}

// イベントリスナー設定
function setupEventListeners() {
  const searchBtn = document.getElementById("btnSearch");
  if (searchBtn) searchBtn.addEventListener("click", handleSearch);

  const searchInput = document.getElementById("searchInput");
  if (searchInput) {
    searchInput.addEventListener("keypress", (e) => {
      if (e.key === "Enter") handleSearch();
    });
  }

  const csvBtn = document.getElementById("btnExportCsv");
  if (csvBtn) csvBtn.addEventListener("click", exportCsv);

  const btnIn = document.getElementById("btnTypeIn");
  const btnOut = document.getElementById("btnTypeOut");
  if (btnIn) btnIn.addEventListener("click", () => setOpsType("in"));
  if (btnOut) btnOut.addEventListener("click", () => setOpsType("out"));

  const btnMinus = document.getElementById("btnQtyMinus");
  const btnPlus = document.getElementById("btnQtyPlus");
  if (btnMinus) btnMinus.addEventListener("click", () => stepQty(-1));
  if (btnPlus) btnPlus.addEventListener("click", () => stepQty(1));

  const btnExec = document.getElementById("btnExecuteOps");
  if (btnExec) btnExec.addEventListener("click", handleExecuteInventoryOps);
}
