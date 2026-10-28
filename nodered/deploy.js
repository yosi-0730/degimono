// flows.json をラズパイの Node-RED に入れるスクリプト（PC から実行。ssh は使わない）
// 使い方: node deploy.js [ホスト]   ホストの既定は 192.168.50.2
// ID が dc で始まるノード（完成品）だけを入れ替え、エディタで作ったほかのタブはそのまま残す。
// 先に node make_flows.js で flows.json を作っておく。

const fs = require("fs");
const path = require("path");

const host = process.argv[2] || "192.168.50.2";
const url = `http://${host}:1880/flows`;

(async () => {
  const cur = await (await fetch(url, { headers: { "Node-RED-API-Version": "v2" } })).json();
  const keep = cur.flows.filter(n => !n.id.startsWith("dc"));
  const mine = JSON.parse(fs.readFileSync(path.join(__dirname, "flows.json"), "utf8"));

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Node-RED-API-Version": "v2",
      "Node-RED-Deployment-Type": "flows", // 変わったフローだけを再起動する
    },
    body: JSON.stringify({ rev: cur.rev, flows: [...keep, ...mine] }),
  });
  if (!res.ok) throw new Error(`デプロイに失敗しました: ${res.status} ${await res.text()}`);
  console.log(`${host} にデプロイしました（完成品 ${mine.length} ノード、ほかのノード ${keep.length} 個はそのまま）`);
  console.log("エディタを開いているときは再読み込み（F5）してください");
})().catch(e => { console.error(e.message); process.exit(1); });
