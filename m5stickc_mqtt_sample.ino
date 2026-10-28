/**
 * M5StickC / M5StickC Plus 用 MQTT 出庫送信・発注点通知サンプル
 *
 * 必要なライブラリ:
 * - M5Unified (by M5Stack)  ※日本語フォント（efont）を使うため M5StickC.h から変更
 * - PubSubClient (by Nick O'Leary)
 * - ArduinoJson (by Benoit Blanchon) v6
 *
 * ボタンA（正面ボタン）を押すと出庫データ (JSON) を degimono/checkout に Publish します。
 * degimono/alert を購読し、発注点以下の通知が来たら text をそのまま画面に表示します。
 */

#include <M5Unified.h>
#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>

// Wi-Fi設定
const char* ssid        = "YOUR_WIFI_SSID";
const char* password    = "YOUR_WIFI_PASSWORD";

// ラズパイのIPアドレスとMQTT設定
const char* mqtt_server = "192.168.x.xxx"; // ラズパイのIPアドレス
const int   mqtt_port   = 1883;
const char* mqtt_topic  = "degimono/checkout";
const char* alert_topic = "degimono/alert";   // 発注点以下の通知（Node-RED から届く）

WiFiClient espClient;
PubSubClient client(espClient);

void setup_wifi() {
  delay(10);
  M5.Lcd.printf("Connecting to %s\n", ssid);
  WiFi.begin(ssid, password);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    M5.Lcd.print(".");
  }
  M5.Lcd.println("\nWiFi connected!");
  M5.Lcd.println(WiFi.localIP());
}

// 発注点以下の通知を受けたとき
// 届く JSON: {"part_id", "part_name", "stock", "reorder_point", "ordered", "text"}
// text は表示用の文（行は \n 区切り）なので、そのまま画面に出す
void onMessage(char* topic, byte* payload, unsigned int length) {
  if (strcmp(topic, alert_topic) != 0) return;

  StaticJsonDocument<768> doc;
  if (deserializeJson(doc, payload, length)) return;  // JSON でなければ無視

  M5.Lcd.fillScreen(BLACK);
  M5.Lcd.setCursor(0, 0);
  M5.Lcd.setTextColor(doc["ordered"] ? YELLOW : RED);  // 発注済みなら黄、未発注なら赤
  M5.Lcd.println(doc["text"].as<const char*>());
  M5.Lcd.setTextColor(WHITE);

  M5.Speaker.tone(2000, 300);  // ブザーのない機種では鳴らない
}

void reconnect() {
  while (!client.connected()) {
    M5.Lcd.print("MQTT connecting...");
    if (client.connect("M5StickC-Client")) {
      M5.Lcd.println("connected!");
      client.subscribe(alert_topic, 1);  // つなぎ直すたびに購読し直す
    } else {
      M5.Lcd.printf("failed, rc=%d try again in 5s\n", client.state());
      delay(5000);
    }
  }
}

// 出庫データの送信
void sendCheckout(const char* part_id, int quantity, const char* user_name, const char* department) {
  StaticJsonDocument<200> doc;
  doc["part_id"]    = part_id;
  doc["quantity"]   = quantity;
  doc["user_name"]  = user_name;   // 社員QRには社員名だけが入る。従業員はサーバー側で名前から引く
  doc["department"] = department;

  char jsonBuffer[256];
  serializeJson(doc, jsonBuffer);

  if (client.publish(mqtt_topic, jsonBuffer)) {
    M5.Lcd.fillScreen(BLACK);
    M5.Lcd.setCursor(0, 0);
    M5.Lcd.setTextColor(GREEN);
    M5.Lcd.println("出庫を送信しました");
    M5.Lcd.setTextColor(WHITE);
    M5.Lcd.printf("品番: %s\n数量: %d\n社員: %s\n", part_id, quantity, user_name);
  } else {
    M5.Lcd.setTextColor(RED);
    M5.Lcd.println("送信に失敗しました");
    M5.Lcd.setTextColor(WHITE);
  }
}

void setup() {
  M5.begin();
  M5.Lcd.setRotation(3);
  M5.Lcd.setFont(&fonts::efontJA_12);  // 日本語を表示するフォント（StickC の小さい画面に合わせて12px）
  M5.Lcd.fillScreen(BLACK);

  setup_wifi();
  client.setServer(mqtt_server, mqtt_port);
  client.setCallback(onMessage);
  client.setBufferSize(1024);  // 標準の256バイトでは日本語の通知が入りきらない

  M5.Lcd.fillScreen(BLACK);
  M5.Lcd.setCursor(0, 0);
  M5.Lcd.println("[Btn A] で出庫");
}

void loop() {
  M5.update();

  if (!client.connected()) {
    reconnect();
  }
  client.loop();  // ここで通知を受け取り、onMessage が呼ばれる

  // 正面の大きなボタン (BtnA) を押したら出庫データを送信
  if (M5.BtnA.wasPressed()) {
    // 例: 山田太郎さんが製造部で近接センサー (AB-1234) を1個出庫
    sendCheckout("AB-1234", 1, "山田太郎", "製造部");
  }

  delay(20);
}
