// ArmBlocks interpreter — Arduino UNO R3 / Adeept ADA031
// EEPROM 0..1 magic AB 01, 2..3 length uint16 LE, 4 XOR of bytecode, 5.. code (max 1000)
// EEPROM 1005: AUTORUN 1 or 0 (anything else, including blank 0xFF, means off)
#include <Servo.h>
#include <EEPROM.h>

struct RepeatFrame {
  uint16_t body;
  uint16_t end;
  uint8_t left;
};

const byte SERVO_COUNT = 5;
const byte SERVO_PINS[SERVO_COUNT] = {9, 6, 5, 3, 11};
const int SERVO_MIN[SERVO_COUNT] = {0, 0, 0, 0, 0};
const int SERVO_MAX[SERVO_COUNT] = {180, 180, 180, 180, 180};
const int HOME_ANGLE[SERVO_COUNT] = {90, 90, 90, 110, 90};
const byte KNOB_PINS[4] = {A0, A1, A2, A3};
const uint16_t CODE_MAX = 1000;
const int CODE_ADDR = 5;
const int AUTORUN_ADDR = 1005;
const uint8_t OP_SPEED = 0x01;
const uint8_t OP_MOVE = 0x02;
const uint8_t OP_POSE = 0x03;
const uint8_t OP_HOME = 0x04;
const uint8_t OP_WAIT = 0x05;
const uint8_t OP_REPEAT = 0x06;
const uint8_t OP_END = 0x07;
const uint8_t OP_KNOB = 0x08;
const uint8_t OP_MSG = 0x09;

Servo servos[SERVO_COUNT];
int currentAngle[SERVO_COUNT] = {90, 90, 90, 110, 90};
int degreesPerSecond = 45;
bool stopped = false;
bool knobMode = false;
bool knobArmed[4] = {false, false, false, false};
bool running = false;
bool loading = false;
bool cancelMotion = false;
uint16_t codeLen = 0;
uint16_t pc = 0;
uint16_t loadNeed = 0;
uint16_t loadGot = 0;
uint8_t loadXor = 0;

RepeatFrame repeatStack[4];
uint8_t repeatDepth = 0;

char lineBuf[140];
uint8_t lineLen = 0;
bool lineOverflow = false;

void attachAll() {
  for (byte i = 0; i < SERVO_COUNT; ++i) {
    if (!servos[i].attached()) servos[i].attach(SERVO_PINS[i]);
    servos[i].write(currentAngle[i]);
  }
}

void detachAll() {
  for (byte i = 0; i < SERVO_COUNT; ++i) servos[i].detach();
}

uint16_t readUint16(int addr) {
  return (uint16_t)EEPROM.read(addr) | ((uint16_t)EEPROM.read(addr + 1) << 8);
}

void writeUint16(int addr, uint16_t value) {
  EEPROM.update(addr, (uint8_t)(value & 0xFF));
  EEPROM.update(addr + 1, (uint8_t)(value >> 8));
}

void failLoad(char kind) {
  loading = false;
  loadNeed = 0;
  loadGot = 0;
  codeLen = 0;
  EEPROM.update(0, 0);
  Serial.print(F("ERR "));
  if (kind == 'H') Serial.print(F("HEX\r\n"));
  else if (kind == 'L') Serial.print(F("LENGTH\r\n"));
  else if (kind == 'C') Serial.print(F("CHECKSUM\r\n"));
  else Serial.print(F("PROGRAM\r\n"));
}

void reportTooLong() {
  if (loading) {
    loading = false;
    loadNeed = 0;
    loadGot = 0;
    codeLen = 0;
    EEPROM.update(0, 0);
  }
  Serial.print(F("ERR TOO_LONG\r\n"));
}

int hexNibble(char digit) {
  if (digit >= '0' && digit <= '9') return (int)(digit - '0');
  if (digit >= 'a' && digit <= 'f') return (int)(digit - 'a' + 10);
  if (digit >= 'A' && digit <= 'F') return (int)(digit - 'A' + 10);
  return -1;
}

uint16_t instructionSize(uint16_t index, uint16_t len) {
  if (index >= len) return 0;
  uint8_t op = EEPROM.read(CODE_ADDR + index);
  switch (op) {
    case OP_SPEED:
      if ((uint16_t)(index + 2) > len) return 0;
      {
        uint8_t speed = EEPROM.read(CODE_ADDR + index + 1);
        if (speed < 5 || speed > 180) return 0;
      }
      return 2;
    case OP_MOVE:
      if ((uint16_t)(index + 3) > len) return 0;
      {
        uint8_t indexServo = EEPROM.read(CODE_ADDR + index + 1);
        uint8_t angle = EEPROM.read(CODE_ADDR + index + 2);
        if (indexServo > 4 || angle > 180) return 0;
      }
      return 3;
    case OP_POSE:
      if ((uint16_t)(index + 6) > len) return 0;
      for (uint8_t joint = 0; joint < 5; ++joint) {
        if (EEPROM.read(CODE_ADDR + index + 1 + joint) > 180) return 0;
      }
      return 6;
    case OP_HOME:
      return 1;
    case OP_WAIT:
      if ((uint16_t)(index + 3) > len) return 0;
      return 3;
    case OP_REPEAT:
      if ((uint16_t)(index + 2) > len) return 0;
      {
        uint8_t count = EEPROM.read(CODE_ADDR + index + 1);
        if (count < 1 || count > 100) return 0;
      }
      return 2;
    case OP_END:
      return 1;
    case OP_KNOB:
      if ((uint16_t)(index + 2) > len) return 0;
      if (EEPROM.read(CODE_ADDR + index + 1) > 1) return 0;
      return 2;
    case OP_MSG: {
      if ((uint16_t)(index + 2) > len) return 0;
      uint8_t textLength = EEPROM.read(CODE_ADDR + index + 1);
      if ((uint16_t)(index + 2 + textLength) > len) return 0;
      return (uint16_t)(2 + textLength);
    }
    default:
      return 0;
  }
}

bool validateProgram(uint16_t len) {
  uint16_t index = 0;
  uint8_t depth = 0;
  while (index < len) {
    uint8_t op = EEPROM.read(CODE_ADDR + index);
    uint16_t size = instructionSize(index, len);
    if (size == 0) return false;
    if (op == OP_REPEAT) {
      if (depth >= 4) return false;
      ++depth;
    } else if (op == OP_END) {
      if (depth == 0) return false;
      --depth;
    }
    index = (uint16_t)(index + size);
  }
  return depth == 0;
}

bool refreshProgram() {
  if (EEPROM.read(0) != 0xAB || EEPROM.read(1) != 0x01) {
    codeLen = 0;
    return false;
  }
  uint16_t len = readUint16(2);
  if (len > CODE_MAX) {
    codeLen = 0;
    return false;
  }
  uint8_t sum = 0;
  for (uint16_t index = 0; index < len; ++index) sum ^= EEPROM.read(CODE_ADDR + index);
  if (sum != EEPROM.read(4) || !validateProgram(len)) {
    codeLen = 0;
    return false;
  }
  codeLen = len;
  return true;
}

void finishLoad() {
  loading = false;
  if (!validateProgram(loadNeed)) {
    failLoad('P');
    return;
  }
  writeUint16(2, loadNeed);
  EEPROM.update(4, loadXor);
  EEPROM.update(1, 0x01);
  EEPROM.update(0, 0xAB);
  if (!refreshProgram() || codeLen != loadNeed) {
    failLoad('C');
    return;
  }
  Serial.print(F("SAVED "));
  Serial.print(loadNeed);
  Serial.print(F("\r\n"));
}

void acceptHexLine(char *text) {
  uint8_t count = 0;
  char *scan = text;
  while (*scan != 0) {
    while (*scan == ' ' || *scan == '\t') ++scan;
    if (*scan == 0) break;
    int high = hexNibble(*scan);
    ++scan;
    if (high < 0 || *scan == 0) {
      failLoad('H');
      return;
    }
    int low = hexNibble(*scan);
    ++scan;
    if (low < 0 || count >= 64) {
      failLoad('H');
      return;
    }
    ++count;
  }
  if ((uint16_t)(loadGot + count) > loadNeed) {
    failLoad('L');
    return;
  }
  scan = text;
  while (*scan != 0) {
    while (*scan == ' ' || *scan == '\t') ++scan;
    if (*scan == 0) break;
    int high = hexNibble(*scan);
    ++scan;
    int low = hexNibble(*scan);
    ++scan;
    uint8_t value = (uint8_t)((high << 4) | low);
    EEPROM.update(CODE_ADDR + (int)loadGot, value);
    loadXor = (uint8_t)(loadXor ^ value);
    ++loadGot;
  }
  if (loadGot < loadNeed) {
    Serial.print(F("OK "));
    Serial.println(loadGot);
  } else finishLoad();
}

bool parseUint16(const char *text, uint16_t *out) {
  if (!text || !*text) return false;
  uint32_t value = 0;
  for (const char *cursor = text; *cursor; ++cursor) {
    if (*cursor < '0' || *cursor > '9') return false;
    value = value * 10 + (uint8_t)(*cursor - '0');
    if (value > 65535UL) return false;
  }
  *out = (uint16_t)value;
  return true;
}

void requestStop() {
  stopped = true;
  running = false;
  knobMode = false;
  cancelMotion = true;
  repeatDepth = 0;
  detachAll();
  Serial.print(F("STOPPED\r\n"));
}

void requestRun() {
  if (!refreshProgram()) {
    running = false;
    cancelMotion = true;
    Serial.print(F("ERR CHECKSUM\r\n"));
    return;
  }
  stopped = false;
  running = true;
  cancelMotion = true;
  attachAll();
  Serial.print(F("RUNNING\r\n"));
}

void beginLoad(uint16_t length) {
  if (length > CODE_MAX) {
    Serial.print(F("ERR LENGTH\r\n"));
    return;
  }
  running = false;
  cancelMotion = true;
  loading = true;
  loadNeed = length;
  loadGot = 0;
  loadXor = 0;
  codeLen = 0;
  EEPROM.update(0, 0);
  Serial.print(F("READY\r\n"));
  Serial.flush();
  if (length == 0) finishLoad();
}

void handleCommand(char *text) {
  while (*text == ' ' || *text == '\t') ++text;
  char *end = text + strlen(text);
  while (end > text && (end[-1] == ' ' || end[-1] == '\t')) {
    --end;
    *end = 0;
  }
  for (char *cursor = text; *cursor; ++cursor) {
    if (*cursor >= 'a' && *cursor <= 'z') *cursor = (char)(*cursor - 32);
  }
  if (!*text) return;

  char *rest = text;
  while (*rest && *rest != ' ' && *rest != '\t') ++rest;
  if (*rest) {
    *rest = 0;
    ++rest;
    while (*rest == ' ' || *rest == '\t') ++rest;
  }

  if (strcmp(text, "PING") == 0 && !*rest) {
    Serial.print(F("PONG ARMBLOCKS 1\r\n"));
    return;
  }
  if (strcmp(text, "RUN") == 0 && !*rest) {
    requestRun();
    return;
  }
  if (strcmp(text, "STOP") == 0 && !*rest) {
    requestStop();
    return;
  }
  if (strcmp(text, "KNOB") == 0 && strcmp(rest, "ON") == 0) {
    stopped = false;
    knobMode = true;
    attachAll();
    for (byte i = 0; i < 4; ++i) knobArmed[i] = false;
    Serial.print(F("KNOB MODE ON — align each knob before it takes control\r\n"));
    return;
  }
  if (strcmp(text, "KNOB") == 0 && strcmp(rest, "OFF") == 0) {
    knobMode = false;
    Serial.print(F("KNOB MODE OFF\r\n"));
    return;
  }
  if (strcmp(text, "LOAD") == 0) {
    uint16_t length = 0;
    if (!parseUint16(rest, &length)) {
      Serial.print(F("ERR LENGTH\r\n"));
      return;
    }
    beginLoad(length);
    return;
  }
  if (strcmp(text, "AUTORUN") == 0 && (strcmp(rest, "0") == 0 || strcmp(rest, "1") == 0)) {
    EEPROM.update(AUTORUN_ADDR, rest[0] == '1' ? 1 : 0);
    Serial.print(F("AUTORUN "));
    Serial.print(rest[0]);
    Serial.print(F("\r\n"));
    return;
  }
  Serial.print(F("ERR UNKNOWN\r\n"));
}

void serviceSerial() {
  while (Serial.available()) {
    char incoming = (char)Serial.read();
    if (incoming == '\r') continue;
    if (incoming != '\n') {
      if (lineLen >= 139) lineOverflow = true;
      else lineBuf[lineLen++] = incoming;
      continue;
    }
    lineBuf[lineLen] = 0;
    bool overflow = lineOverflow;
    lineLen = 0;
    lineOverflow = false;
    if (overflow) {
      reportTooLong();
      continue;
    }
    if (loading) acceptHexLine(lineBuf);
    else handleCommand(lineBuf);
  }
}

void safeDelay(unsigned long duration) {
  unsigned long started = millis();
  while (!stopped && !cancelMotion && (unsigned long)(millis() - started) < duration) {
    serviceSerial();
    delay(5);
  }
}

void moveServoSafe(byte index, int target) {
  if (index >= SERVO_COUNT || stopped || cancelMotion) return;
  int lower = SERVO_MIN[index];
  int upper = SERVO_MAX[index];
  if (target < lower) target = lower;
  if (target > upper) target = upper;
  int stepDirection = 1;
  if (target < currentAngle[index]) stepDirection = -1;
  int speed = degreesPerSecond;
  if (speed < 1) speed = 1;
  unsigned long stepDelay = 1000UL / (unsigned long)speed;
  if (stepDelay < 6UL) stepDelay = 6UL;
  while (currentAngle[index] != target && !stopped && !cancelMotion) {
    currentAngle[index] += stepDirection;
    servos[index].write(currentAngle[index]);
    safeDelay(stepDelay);
  }
}

void movePose(int a0, int a1, int a2, int a3, int a4) {
  int target[5] = {a0, a1, a2, a3, a4};
  for (byte i = 0; i < SERVO_COUNT && !stopped && !cancelMotion; ++i) moveServoSafe(i, target[i]);
}

void serviceKnobs() {
  if (!knobMode || stopped) return;
  for (byte i = 0; i < 4; ++i) {
    int reading = analogRead(KNOB_PINS[i]);
    int lower = SERVO_MIN[i];
    int upper = SERVO_MAX[i];
    int span = upper - lower;
    int target = lower + (int)(((long)reading * (long)span) / 1023L);
    int delta = target - currentAngle[i];
    if (delta < 0) delta = -delta;
    if (!knobArmed[i]) {
      if (delta <= 6) knobArmed[i] = true;
      continue;
    }
    if (delta >= 3) moveServoSafe(i, target);
  }
}

uint16_t findEnd(uint16_t from) {
  uint16_t index = from;
  uint8_t depth = 0;
  while (index < codeLen) {
    uint8_t op = EEPROM.read(CODE_ADDR + index);
    uint16_t size = instructionSize(index, codeLen);
    if (size == 0) return 0xFFFF;
    if (op == OP_END && depth == 0) return index;
    if (op == OP_REPEAT) ++depth;
    else if (op == OP_END) --depth;
    index = (uint16_t)(index + size);
  }
  return 0xFFFF;
}

void faultProgram() {
  running = false;
  cancelMotion = true;
  Serial.print(F("ERR PROGRAM\r\n"));
}

int readCode() {
  if (pc >= codeLen) return -1;
  return EEPROM.read(CODE_ADDR + pc++);
}

void executeOne() {
  serviceSerial();
  if (!running || stopped || cancelMotion || loading) return;
  if (pc >= codeLen) return;
  int op = readCode();
  if (op < 0) {
    faultProgram();
    return;
  }
  switch (op) {
    case OP_SPEED: {
      int speed = readCode();
      if (speed < 5 || speed > 180) {
        faultProgram();
        return;
      }
      degreesPerSecond = speed;
      break;
    }
    case OP_MOVE: {
      int index = readCode();
      int angle = readCode();
      if (index < 0 || index > 4 || angle < 0 || angle > 180) {
        faultProgram();
        return;
      }
      moveServoSafe((byte)index, angle);
      break;
    }
    case OP_POSE: {
      int angle[5];
      for (byte joint = 0; joint < 5; ++joint) {
        angle[joint] = readCode();
        if (angle[joint] < 0 || angle[joint] > 180) {
          faultProgram();
          return;
        }
      }
      movePose(angle[0], angle[1], angle[2], angle[3], angle[4]);
      break;
    }
    case OP_HOME:
      movePose(HOME_ANGLE[0], HOME_ANGLE[1], HOME_ANGLE[2], HOME_ANGLE[3], HOME_ANGLE[4]);
      break;
    case OP_WAIT: {
      int low = readCode();
      int high = readCode();
      if (low < 0 || high < 0) {
        faultProgram();
        return;
      }
      unsigned long tenths = (uint16_t)low | ((uint16_t)high << 8);
      safeDelay(tenths * 100UL);
      break;
    }
    case OP_REPEAT: {
      int count = readCode();
      if (count < 1 || count > 100 || repeatDepth >= 4) {
        faultProgram();
        return;
      }
      uint16_t end = findEnd(pc);
      if (end == 0xFFFF) {
        faultProgram();
        return;
      }
      repeatStack[repeatDepth].body = pc;
      repeatStack[repeatDepth].end = end;
      repeatStack[repeatDepth].left = (uint8_t)count;
      ++repeatDepth;
      break;
    }
    case OP_END:
      if (repeatDepth == 0) {
        faultProgram();
        return;
      }
      if (repeatStack[repeatDepth - 1].left > 1) {
        --repeatStack[repeatDepth - 1].left;
        pc = repeatStack[repeatDepth - 1].body;
      } else {
        --repeatDepth;
      }
      break;
    case OP_KNOB: {
      int enabled = readCode();
      if (enabled < 0 || enabled > 1) {
        faultProgram();
        return;
      }
      knobMode = enabled == 1;
      break;
    }
    case OP_MSG: {
      int textLength = readCode();
      if (textLength < 0) {
        faultProgram();
        return;
      }
      for (int index = 0; index < textLength; ++index) {
        int value = readCode();
        if (value < 0) {
          faultProgram();
          return;
        }
        Serial.write((uint8_t)value);
      }
      Serial.print(F("\r\n"));
      break;
    }
    default:
      faultProgram();
      break;
  }
}

void runPass() {
  do {
    cancelMotion = false;
    pc = 0;
    repeatDepth = 0;
    if (codeLen == 0) {
      safeDelay(10);
      return;
    }
    while (!cancelMotion && running && !stopped && !loading && pc < codeLen) executeOne();
    if (!cancelMotion && running && !stopped && !loading && pc >= codeLen) {
      running = false;
      Serial.print(F("DONE\r\n"));
    }
  } while (cancelMotion && running && !stopped && !loading && !knobMode);
}

void setup() {
  Serial.begin(115200);
  Serial.setTimeout(20);
  degreesPerSecond = 45;
  knobMode = false;
  stopped = false;
  running = false;
  loading = false;
  cancelMotion = false;
  attachAll();
  if (EEPROM.read(AUTORUN_ADDR) != 1) {
    Serial.print(F("ARMBLOCKS READY\r\n"));
    return;
  }
  if (!refreshProgram()) {
    Serial.print(F("ERR CHECKSUM\r\n"));
    return;
  }
  running = true;
  Serial.print(F("RUNNING\r\n"));
}

void loop() {
  serviceSerial();
  serviceKnobs();
  if (loading) return;
  if (!running || stopped || knobMode) {
    delay(10);
    return;
  }
  runPass();
}
