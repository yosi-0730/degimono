"""QRコード生成ツール

QRは種類ごとに別々に作る（社員・部署・部品・個数）。中身は1行で「項目名,値」。
項目名は 社員名 / 部署名 / 品番 / 個数 の4つ（社員IDは入れない）。
    社員   社員名,山田太郎
    部署   部署名,製造部
    部品   品番,AB-1234
    個数   個数,5

■ 1件だけ作る
    python qr_generator.py 山田太郎 --label 社員名
    python qr_generator.py 製造部 --label 部署名

■ app.py のデモデータからまとめて作る
    python qr_generator.py --demo

■ HTML一覧（QRの下に中身の文字列つき。qr_output\\html\\ に出力）
    python qr_generator.py --html
"""
import argparse
import ast
import base64
import html
import io
import os

import qrcode
from qrcode.constants import ERROR_CORRECT_M

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
APP_PY = os.path.join(BASE_DIR, "app.py")
QUANTITIES = [1, 2, 3, 5, 10]  # m5_dummy.html の個数QRに合わせる
SEP = ","  # 「項目名」と「値」の区切り
LABELS = ("社員名", "部署名", "品番", "個数")


def load_demo_data(path=APP_PY):
    """app.py を実行せず、EMPLOYEES / DEPARTMENTS / PARTS だけ読み出す"""
    wanted = {"EMPLOYEES", "DEPARTMENTS", "PARTS"}
    with open(path, encoding="utf-8") as f:
        tree = ast.parse(f.read())
    data = {}
    for node in tree.body:
        if isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name):
            name = node.targets[0].id
            if name in wanted:
                data[name] = ast.literal_eval(node.value)
    missing = wanted - data.keys()
    if missing:
        raise SystemExit(f"app.py から読み出せませんでした: {', '.join(sorted(missing))}")
    return data


def build_payload(value, label):
    return f"{label}{SEP}{value}"


def make_qr_image(data, size=10, border=4):
    qr = qrcode.QRCode(
        version=None,  # データ量に応じて自動で決定
        error_correction=ERROR_CORRECT_M,
        box_size=size,
        border=border,
    )
    qr.add_data(data)
    qr.make(fit=True)
    return qr.make_image(fill_color="black", back_color="white")


def generate_qr(data, output, size=10, border=4):
    os.makedirs(os.path.dirname(os.path.abspath(output)), exist_ok=True)
    make_qr_image(data, size, border).save(output)
    return output


def build_demo_items():
    """デモデータから (種類キー, ファイル名, QRの中身) の一覧を作る"""
    d = load_demo_data()
    pay = lambda label, value: build_payload(value, label)

    items = []
    for emp_id, name, *_ in d["EMPLOYEES"]:
        items.append(("employees", f"{emp_id}_{name}", pay("社員名", name)))
    for dept in d["DEPARTMENTS"]:
        items.append(("departments", dept, pay("部署名", dept)))
    for part_id, part_name, *_ in d["PARTS"]:
        items.append(("parts", f"{part_id}_{part_name}", pay("品番", part_id)))
    for q in QUANTITIES:
        items.append(("quantities", f"{q}個", pay("個数", q)))
    return items


def generate_demo(out_dir, size=10):
    items = build_demo_items()
    for sub, fname, payload in items:
        generate_qr(payload, os.path.join(out_dir, sub, f"{fname}.png"), size)
    return items


# ---- HTML出力 ----
CATEGORY_TITLES = {
    "employees": "社員",
    "departments": "部署",
    "parts": "部品",
    "quantities": "個数",
}

HTML_TEMPLATE = """<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<style>
  /* A4縦・余白10mm。カード60x66mmを3列で並べる（1ページ 3列x4行=12枚） */
  @page {{ size: A4 portrait; margin: 10mm; }}
  * {{ box-sizing: border-box; }}
  body {{ font-family: "Yu Gothic", "Meiryo", sans-serif; margin: 0; padding: 10mm; color: #000;
          background: #fff; -webkit-print-color-adjust: exact; print-color-adjust: exact; }}
  h1 {{ font-size: 14pt; margin: 0 0 2mm; }}
  .note {{ color: #555; font-size: 9pt; margin: 0 0 4mm; }}
  h2 {{ font-size: 12pt; margin: 6mm 0 3mm; border-bottom: 0.3mm solid #000; padding-bottom: 1mm;
        break-after: avoid; }}
  .grid {{ display: grid; grid-template-columns: repeat(3, 60mm); justify-content: center; }}
  .tag {{ font-size: 8pt; color: #555; height: 5mm; line-height: 5mm; }}
  .card {{ width: 60mm; height: 66mm; padding: 2mm 2mm 2mm; text-align: center;
           border: 0.2mm dashed #888; margin: -0.1mm; /* 隣のカードと枠線を重ねて切り取り線にする */
           break-inside: avoid; display: flex; flex-direction: column; align-items: center; }}
  .card img {{ width: 45mm; height: 45mm; image-rendering: pixelated; }}
  .payload {{ margin-top: 2mm; font-size: 12pt; font-weight: bold; line-height: 1.25;
              word-break: break-all; }}
  @media print {{ body {{ padding: 0; }} }}
</style>
</head>
<body>
<h1>{title}</h1>
<p class="note">QRの下の文字列が、QRに入っている中身です（項目名,値）。印刷: A4縦・倍率100%（拡大縮小なし）。点線に沿って切り取り。</p>
{sections}
</body>
</html>
"""


def _card_html(payload, size, tag):
    buf = io.BytesIO()
    make_qr_image(payload, size).save(buf, format="PNG")
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    text = html.escape(payload)
    return (f'<div class="card"><div class="tag">{html.escape(tag)}</div>'
            f'<img src="data:image/png;base64,{b64}" alt="{text}">'
            f'<div class="payload">{text}</div></div>')


def _grid_html(cards):
    return '<div class="grid">\n' + "\n".join(cards) + '\n</div>'


def _section_html(title, cards):
    return f'<h2>{html.escape(title)}</h2>\n{_grid_html(cards)}'


def write_html(path, title, sections):
    body = "\n".join(sections)
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(HTML_TEMPLATE.format(title=html.escape(title), sections=body))


def generate_html(out_dir, size=10):
    """minimal（各種類1件ずつ）と、種類ごとのHTMLを作る。作ったファイルのパス一覧を返す"""
    items = build_demo_items()
    by_cat = {c: [p for k, _, p in items if k == c] for c in CATEGORY_TITLES}

    written = []
    path = os.path.join(out_dir, "minimal.html")
    minimal_cards = [_card_html(payloads[0], size, CATEGORY_TITLES[c]) for c, payloads in by_cat.items()]
    write_html(path, "QRデモ 最小セット", [_grid_html(minimal_cards)])
    written.append(path)

    for cat, payloads in by_cat.items():
        path = os.path.join(out_dir, f"{cat}.html")
        cards = [_card_html(p, size, CATEGORY_TITLES[cat]) for p in payloads]
        write_html(path, f"QRデモ {CATEGORY_TITLES[cat]}だけ",
                   [_section_html(f"{CATEGORY_TITLES[cat]}（{len(payloads)}件）", cards)])
        written.append(path)
    return written


def main():
    p = argparse.ArgumentParser(description="QRコードを画像として生成します")
    p.add_argument("value", nargs="?", help="QRにする値（例: 山田太郎）")
    p.add_argument("--label", choices=LABELS, help="項目名（1件だけ作るときは必須）")
    p.add_argument("-o", "--output", help="出力ファイル名（省略時は qr_<値>.png）")
    p.add_argument("--demo", action="store_true", help="app.py のデモデータから一括生成")
    p.add_argument("--html", action="store_true",
                   help="デモデータからHTML一覧（最小セット・種類ごと）を生成")
    p.add_argument("--out-dir", default=os.path.join(BASE_DIR, "qr_output"),
                   help="--demo の出力先フォルダ")
    p.add_argument("--size", type=int, default=10, help="1マスのピクセル数")
    a = p.parse_args()

    if a.html:
        for path in generate_html(os.path.join(a.out_dir, "html")):
            print(f"生成しました: {path}")
        return

    if a.demo:
        items = generate_demo(a.out_dir, a.size)
        print(f"{len(items)}件生成しました: {a.out_dir}")
        return

    if not a.value:
        p.error("値を指定するか --demo / --html を付けてください")
    if not a.label:
        p.error("--label で項目名（社員名 / 部署名 / 品番 / 個数）を指定してください")
    output = a.output or f"qr_{a.value}.png"
    payload = build_payload(a.value, a.label)
    generate_qr(payload, output, a.size)
    print(f"生成しました: {output}")
    print(f"QRの中身: {payload}")


if __name__ == "__main__":
    main()
