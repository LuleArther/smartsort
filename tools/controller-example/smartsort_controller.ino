// SmartSort controller example (Arduino / ESP32), a starting point only.
//
// Reads SmartSort's machine-link commands over USB serial, one JSON line
// per item, and turns a diverter servo to the gate for that category:
//   {"type":"sort","category":"plastic","bin":"Plastic collection bin","x":0.41,"y":0.62,...}
//   {"type":"manual",...}  -> reject/manual gate
// In SmartSort: Settings > Machine link > USB serial, 115200 baud > Connect,
// then Sort > Live detection > Table / conveyor.
//
// Safety: this sketch has no safety logic. A real machine needs a hardware
// emergency stop that cuts actuator power, guards and interlocks, and must
// not rely on the PC or this link to stop.

#include <Servo.h>

const int SERVO_PIN = 9;
// The gate moves as soon as a command arrives (never delay() here: on an
// Uno the 64-byte serial buffer would overflow while waiting). On a moving
// conveyor, schedule the move instead from the item's "y" and the belt speed.

struct Gate { const char* category; int angle; };
const Gate GATES[] = {
  {"plastic", 20}, {"glass", 50}, {"paper", 80}, {"metal", 110}, {"organic", 140},
  {"pet", 20}, {"hdpe", 50}, {"pp", 80}, {"ldpe", 110},
};
const int REJECT_ANGLE = 170;  // manual inspection / anything unknown

Servo diverter;
char line[384];  // a command is about 250 characters
size_t len = 0;

// Minimal value lookup for "key":"value" in a flat JSON line (no library needed).
bool jsonString(const char* json, const char* key, char* out, size_t outSize) {
  char pattern[40];
  snprintf(pattern, sizeof(pattern), "\"%s\":\"", key);
  const char* p = strstr(json, pattern);
  if (!p) return false;
  p += strlen(pattern);
  size_t i = 0;
  while (*p && *p != '"' && i < outSize - 1) out[i++] = *p++;
  out[i] = '\0';
  return true;
}

void handle(const char* json) {
  char type[16], category[32];
  if (!jsonString(json, "type", type, sizeof(type))) return;
  if (strcmp(type, "sort") != 0 && strcmp(type, "manual") != 0 && strcmp(type, "test") != 0) return;
  int angle = REJECT_ANGLE;
  if (strcmp(type, "manual") != 0 && jsonString(json, "category", category, sizeof(category))) {
    for (const Gate& g : GATES) if (strcmp(g.category, category) == 0) angle = g.angle;
  }
  diverter.write(angle);
  Serial.print("{\"ack\":\"");
  Serial.print(type);
  Serial.print("\",\"angle\":");
  Serial.print(angle);
  Serial.println("}");
}

void setup() {
  Serial.begin(115200);
  diverter.attach(SERVO_PIN);
  diverter.write(REJECT_ANGLE);
}

void loop() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n') { line[len] = '\0'; handle(line); len = 0; }
    else if (len < sizeof(line) - 1) line[len++] = c;
  }
}
