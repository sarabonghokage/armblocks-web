import * as Blockly from 'blockly';
import 'blockly/blocks';
import './style.css';
import { compileWorkspace } from './compile.js';
import { flashImage, parseIntelHex } from './stk500.js';

const SERVOS = ['베이스', '어깨', '팔꿈치', '손목', '그리퍼'];
const STORAGE_KEY = 'armblocks-workspace';
const encoder = new TextEncoder();

document.querySelector('#app').innerHTML = `
  <div class="shell">
    <div class="banner" id="serialBanner" hidden>이 브라우저는 보드 연결을 지원하지 않습니다. Chrome 또는 Edge에서 열어 주세요.</div>
    <header class="topbar">
      <div class="brand"><span class="brand-mark">AB</span><div><strong>ArmBlocks</strong><small>ADA031 WEB</small></div></div>
      <div class="actions">
        <button class="button secondary" id="connectButton">연결</button>
        <button class="button secondary" id="flashButton">해석기 펌웨어 설치</button>
        <button class="button primary" id="saveBoardButton">보드에 저장</button>
        <button class="button primary" id="runButton">실행</button>
        <button class="button danger" id="stopButton">정지</button>
        <button class="button secondary" id="knobButton">노브 비상모드</button>
        <label class="check"><input id="autorunBox" type="checkbox">전원 켤 때 자동 실행</label>
        <div class="flash-progress" id="flashProgress" hidden><div id="flashProgressBar"></div></div>
      </div>
    </header>
    <section class="notice" id="notice"><span class="notice-icon">!</span><p><strong>처음 움직이기 전:</strong> 팔을 손으로 받치고, 작업 반경을 비운 뒤, 서보 전원은 꺼진 상태에서 업로드하세요.</p><button id="dismissNotice">확인</button></section>
    <main class="workspace-layout">
      <section class="editor-panel">
        <div class="panel-head">
          <div><span class="eyebrow">BLOCK PROGRAM</span><h1>동작 만들기</h1><p class="status-line" id="statusLine">블록을 연결해 프로그램을 만드세요.</p></div>
          <div class="panel-tools"><button class="text-button" id="openButton">파일 열기</button><button class="text-button" id="saveButton">저장</button></div>
        </div>
        <div id="blocklyDiv"></div>
      </section>
      <aside class="inspector">
        <div class="tabs">
          <button class="tab active" data-tab="commands">명령 보기</button>
          <button class="tab" data-tab="log">시리얼 로그</button>
        </div>
        <div class="tab-page active" id="tab-commands"><div class="console-actions"></div><pre id="commandView"></pre></div>
        <div class="tab-page" id="tab-log"><div class="console-actions"><button id="clearLog">로그 지우기</button></div><pre id="serialLog">시리얼 로그가 여기에 표시됩니다.\n</pre></div>
      </aside>
    </main>
  </div>
  <input id="fileInput" type="file" accept=".armblocks,.json,application/json" hidden>`;

if (!('serial' in navigator)) document.querySelector('#serialBanner').hidden = false;

Blockly.defineBlocksWithJsonArray([
  { type: 'arm_start', message0: '로봇팔 시작', message1: '%1', args1: [{ type: 'input_statement', name: 'DO' }], colour: 18 },
  { type: 'arm_home', message0: '안전 홈 위치로 이동', previousStatement: null, nextStatement: null, colour: 188 },
  { type: 'arm_move', message0: '%1 관절을 %2 °로 이동', args0: [{ type: 'field_dropdown', name: 'SERVO', options: [['베이스','0'],['어깨','1'],['팔꿈치','2'],['손목','3'],['그리퍼','4']] }, { type: 'field_number', name: 'ANGLE', value: 90, min: 0, max: 180, precision: 1 }], previousStatement: null, nextStatement: null, colour: 188 },
  { type: 'arm_pose', message0: '자세 설정  베이스 %1  어깨 %2  팔꿈치 %3  손목 %4  그리퍼 %5', args0: [{ type: 'field_number', name: 'A0', value: 90, min: 0, max: 180 }, { type: 'field_number', name: 'A1', value: 90, min: 0, max: 180 }, { type: 'field_number', name: 'A2', value: 90, min: 0, max: 180 }, { type: 'field_number', name: 'A3', value: 110, min: 0, max: 180 }, { type: 'field_number', name: 'A4', value: 90, min: 0, max: 180 }], previousStatement: null, nextStatement: null, colour: 188 },
  { type: 'arm_speed', message0: '이동 속도 %1 °/초', args0: [{ type: 'field_number', name: 'SPEED', value: 45, min: 5, max: 180 }], previousStatement: null, nextStatement: null, colour: 43 },
  { type: 'arm_wait', message0: '%1 초 기다리기', args0: [{ type: 'field_number', name: 'SECONDS', value: 1, min: 0, max: 60, precision: 0.1 }], previousStatement: null, nextStatement: null, colour: 43 },
  { type: 'arm_repeat', message0: '%1 번 반복', args0: [{ type: 'field_number', name: 'COUNT', value: 2, min: 1, max: 100 }], message1: '%1', args1: [{ type: 'input_statement', name: 'DO' }], previousStatement: null, nextStatement: null, colour: 292 },
  { type: 'arm_knob', message0: '노브 비상 제어를 %1', args0: [{ type: 'field_dropdown', name: 'MODE', options: [['허용','true'],['차단','false']] }], previousStatement: null, nextStatement: null, colour: 345 },
  { type: 'arm_print', message0: '상태 메시지 %1', args0: [{ type: 'field_input', name: 'TEXT', text: '동작 완료' }], previousStatement: null, nextStatement: null, colour: 120 }
]);

const toolbox = { kind: 'categoryToolbox', contents: [
  { kind: 'category', name: '시작', colour: '#E36542', contents: [{ kind: 'block', type: 'arm_start' }] },
  { kind: 'category', name: '움직임', colour: '#168C89', contents: [{ kind: 'block', type: 'arm_home' }, { kind: 'block', type: 'arm_move' }, { kind: 'block', type: 'arm_pose' }] },
  { kind: 'category', name: '시간 · 속도', colour: '#C98D19', contents: [{ kind: 'block', type: 'arm_speed' }, { kind: 'block', type: 'arm_wait' }] },
  { kind: 'category', name: '제어', colour: '#7558B8', contents: [{ kind: 'block', type: 'arm_repeat' }] },
  { kind: 'category', name: '안전 · 통신', colour: '#B73A62', contents: [{ kind: 'block', type: 'arm_knob' }, { kind: 'block', type: 'arm_print' }] }
] };
const theme = Blockly.Theme.defineTheme('armblocks', { base: Blockly.Themes.Classic, componentStyles: { workspaceBackgroundColour: '#F8F7F3', toolboxBackgroundColour: '#ECE9E1', toolboxForegroundColour: '#3A3934', flyoutBackgroundColour: '#FFFDF8', flyoutForegroundColour: '#333', scrollbarColour: '#C7C2B7', insertionMarkerColour: '#E36542', insertionMarkerOpacity: 0.35, cursorColour: '#168C89' }, fontStyle: { family: 'Noto Sans KR, Segoe UI, sans-serif', weight: '600', size: 12 } });
const workspace = Blockly.inject('blocklyDiv', { toolbox, theme, renderer: 'zelos', trashcan: true, grid: { spacing: 24, length: 2, colour: '#DEDAD0', snap: true }, zoom: { controls: true, wheel: true, startScale: 0.9, maxScale: 1.4, minScale: 0.55 } });
// Ctrl+C로 블록을 복사할 때 아래에 연결된 블록까지 함께 복사한다. (잘라내기·복제는 기존 동작 유지)
let copyWholeStack = false;
const originalToCopyData = Blockly.BlockSvg.prototype.toCopyData;
Blockly.BlockSvg.prototype.toCopyData = function (addNextBlocks = copyWholeStack) { return originalToCopyData.call(this, addNextBlocks); };
const copyShortcutName = Blockly.ShortcutItems.names.COPY;
const copyShortcut = Blockly.ShortcutRegistry.registry.getRegistry()[copyShortcutName];
if (copyShortcut) {
  Blockly.ShortcutRegistry.registry.unregister(copyShortcutName);
  Blockly.ShortcutRegistry.registry.register({ ...copyShortcut, callback(...args) { copyWholeStack = true; try { return copyShortcut.callback(...args); } finally { copyWholeStack = false; } } });
}

const commandView = document.querySelector('#commandView');
const serialLog = document.querySelector('#serialLog');
const statusLine = document.querySelector('#statusLine');
const connectButton = document.querySelector('#connectButton');
const flashButton = document.querySelector('#flashButton');
const flashProgress = document.querySelector('#flashProgress');
const flashProgressBar = document.querySelector('#flashProgressBar');
const knobButton = document.querySelector('#knobButton');

let port = null;
let reader = null;
let writer = null;
let readLoop = null;
let waiter = null;
let writeTail = Promise.resolve();
let commandTail = Promise.resolve();
const pendingLines = [];
let knobOn = false;
let closing = false;
let flashing = false;

function setStatus(text, isError = false) {
  statusLine.textContent = text;
  statusLine.classList.toggle('error', isError);
}

function currentProgram() {
  return compileWorkspace(Blockly.serialization.workspaces.save(workspace));
}

function describeBytes(bytes) {
  const lines = [];
  let index = 0;
  let depth = 0;
  const pad = () => '  '.repeat(depth);
  while (index < bytes.length) {
    const op = bytes[index++];
    if (op === 0x01) lines.push(`${pad()}SPEED ${bytes[index++]}`);
    else if (op === 0x02) {
      const servo = bytes[index++];
      lines.push(`${pad()}MOVE ${SERVOS[servo] || servo} ${bytes[index++]}`);
    } else if (op === 0x03) {
      const angles = [];
      for (let count = 0; count < 5; count += 1) angles.push(bytes[index++]);
      lines.push(`${pad()}POSE ${angles.join(' ')}`);
    } else if (op === 0x04) lines.push(`${pad()}HOME`);
    else if (op === 0x05) {
      const tenths = bytes[index++] | (bytes[index++] << 8);
      lines.push(`${pad()}WAIT ${tenths / 10}`);
    } else if (op === 0x06) lines.push(`${pad()}REPEAT ${bytes[index++]}`);
    else if (op === 0x07) {
      depth = Math.max(0, depth - 1);
      lines.push(`${'  '.repeat(depth)}END`);
    } else if (op === 0x08) lines.push(`${pad()}KNOB ${bytes[index++] ? '허용' : '차단'}`);
    else if (op === 0x09) {
      const length = bytes[index++];
      const text = new TextDecoder().decode(bytes.subarray(index, index + length));
      index += length;
      lines.push(`${pad()}MSG ${text}`);
    } else {
      lines.push(`${pad()}? ${op.toString(16)}`);
      break;
    }
    if (op === 0x06) depth += 1;
  }
  return lines.join('\n');
}

function refreshCommands() {
  const result = currentProgram();
  if (!result.ok) {
    commandView.textContent = result.error;
    commandView.classList.add('has-error');
    return result;
  }
  commandView.classList.remove('has-error');
  commandView.textContent = result.bytes.length ? describeBytes(result.bytes) : '프로그램이 비어 있습니다';
  return result;
}

function rememberWorkspace() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(Blockly.serialization.workspaces.save(workspace))); } catch {}
}

function loadExample() {
  workspace.clear();
  const state = { blocks: { languageVersion: 0, blocks: [{ type: 'arm_start', x: 42, y: 48, inputs: { DO: { block: { type: 'arm_speed', fields: { SPEED: 35 }, next: { block: { type: 'arm_home', next: { block: { type: 'arm_move', fields: { SERVO: '4', ANGLE: 35 }, next: { block: { type: 'arm_wait', fields: { SECONDS: 1 }, next: { block: { type: 'arm_move', fields: { SERVO: '4', ANGLE: 90 }, next: { block: { type: 'arm_print', fields: { TEXT: '집기 동작 완료' } } } } } } } } } } } } } } }] } };
  Blockly.serialization.workspaces.load(state, workspace);
}

try {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) Blockly.serialization.workspaces.load(JSON.parse(saved), workspace);
  else loadExample();
} catch { loadExample(); }

workspace.addChangeListener((event) => {
  if (event.isUiEvent) return;
  rememberWorkspace();
  refreshCommands();
});
refreshCommands();

function appendLog(text) {
  serialLog.textContent += `${text}\n`;
  serialLog.scrollTop = serialLog.scrollHeight;
}

function writeRaw(text) {
  const payload = encoder.encode(text.endsWith('\n') ? text : `${text}\n`);
  const run = writeTail.then(() => {
    if (!writer) throw new Error('보드가 연결되지 않았습니다');
    return writer.write(payload);
  });
  writeTail = run.then(() => {}, () => {});
  return run;
}

function onLine(line) {
  const text = line.trim();
  if (!text) return;
  appendLog(text);
  if (text === 'DONE') setStatus('프로그램 실행이 끝났습니다.');
  if (waiter && (text.startsWith('ERR') || text.startsWith('STOPPED') || waiter.accept(text))) {
    const current = waiter;
    waiter = null;
    clearTimeout(current.timer);
    current.resolve(text);
    return;
  }
  pendingLines.push(text);
}

function waitForLine(accept, timeoutMs) {
  const queued = pendingLines.findIndex((line) => line.startsWith('ERR') || line.startsWith('STOPPED') || accept(line));
  if (queued >= 0) return Promise.resolve(pendingLines.splice(queued, 1)[0]);
  return new Promise((resolve, reject) => {
    const current = {
      accept,
      resolve,
      timer: setTimeout(() => {
        if (waiter === current) waiter = null;
        reject(new Error('응답 시간 초과'));
      }, timeoutMs)
    };
    waiter = current;
  });
}

async function request(text, accept, timeoutMs = 3000) {
  const pending = waitForLine(accept, timeoutMs);
  try {
    await writeRaw(text);
  } catch (error) {
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter = null;
    }
    throw error;
  }
  const line = await pending;
  if (line.startsWith('ERR') || line.startsWith('STOPPED')) throw new Error(line);
  return line;
}

function enqueue(task) {
  const run = commandTail.then(() => {
    pendingLines.length = 0;
    return task();
  }, () => {
    pendingLines.length = 0;
    return task();
  });
  commandTail = run.then(() => {}, () => {});
  return run;
}

async function readLoopBody() {
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      let line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      onLine(line);
      newline = buffer.indexOf('\n');
    }
  }
}

async function pauseStreams() {
  closing = true;
  if (waiter) {
    clearTimeout(waiter.timer);
    waiter = null;
  }
  pendingLines.length = 0;
  const pending = readLoop;
  try { await reader?.cancel(); } catch {}
  try { reader?.releaseLock(); } catch {}
  try { writer?.releaseLock(); } catch {}
  reader = null;
  writer = null;
  readLoop = null;
  if (pending) await pending.catch(() => {});
  closing = false;
}

function createByteIo(serialPort) {
  const byteReader = serialPort.readable.getReader();
  const byteWriter = serialPort.writable.getWriter();
  const chunks = [];
  let buffered = 0;
  let waiter = null;
  let stopped = false;
  let readError = null;

  const pump = (async () => {
    try {
      while (!stopped) {
        const { value, done } = await byteReader.read();
        if (done) break;
        if (!value?.length) continue;
        chunks.push(value);
        buffered += value.length;
        if (waiter && buffered >= waiter.need) waiter.resolve();
      }
    } catch (error) {
      readError = error;
      if (waiter) waiter.reject(error);
    }
  })();

  function take(count) {
    const out = new Uint8Array(count);
    let filled = 0;
    while (filled < count) {
      const head = chunks[0];
      const need = count - filled;
      if (head.length <= need) {
        out.set(head, filled);
        filled += head.length;
        chunks.shift();
      } else {
        out.set(head.subarray(0, need), filled);
        chunks[0] = head.subarray(need);
        filled = count;
      }
    }
    buffered -= count;
    return out;
  }

  function beginRead(count, timeoutMs) {
    if (readError) return Promise.reject(readError);
    if (buffered >= count) return Promise.resolve(take(count));
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (run) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (waiter?.finish === finish) waiter = null;
        run();
      };
      const timer = setTimeout(() => {
        finish(() => {
          const error = new Error('응답 시간 초과');
          error.timeout = true;
          reject(error);
        });
      }, timeoutMs);
      waiter = {
        need: count,
        finish,
        resolve: () => finish(() => resolve(take(count))),
        reject: (error) => finish(() => reject(error))
      };
      if (readError) waiter.reject(readError);
      else if (buffered >= count) waiter.resolve();
    });
  }

  return {
    write(data) { return byteWriter.write(data); },
    read: beginRead,
    setSignals(signals) { return serialPort.setSignals(signals); },
    sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); },
    async stop() {
      stopped = true;
      if (waiter) waiter.reject(new Error('포트가 닫혔습니다'));
      try { await byteReader.cancel(); } catch {}
      await pump.catch(() => {});
      try { byteReader.releaseLock(); } catch {}
      try { byteWriter.releaseLock(); } catch {}
    }
  };
}

async function openAt(baud) {
  await pauseStreams();
  if (port?.readable || port?.writable) {
    try { await port.close(); } catch {}
  }
  await port.open({ baudRate: baud });
}

async function attachInterpreter() {
  closing = false;
  writer = port.writable.getWriter();
  reader = port.readable.getReader();
  readLoop = readLoopBody().catch((error) => {
    if (!closing) setStatus(error.message || '시리얼 연결이 끊겼습니다.', true);
  });
  try {
    await waitForLine((line) => line === 'ARMBLOCKS READY' || line === 'RUNNING' || line === 'ERR CHECKSUM', 4000);
  } catch {
    // 4초 안에 부팅 줄이 없어도 실패로 보지 않고 PING으로 확인한다.
  }
  await request('PING', (line) => line.includes('PONG ARMBLOCKS 1'));
  connectButton.textContent = '연결 해제';
  setStatus('해석기가 연결되었습니다.');
}

async function disconnect(message) {
  closing = true;
  if (waiter) {
    clearTimeout(waiter.timer);
    waiter = null;
  }
  pendingLines.length = 0;
  try { await reader?.cancel(); } catch {}
  try { reader?.releaseLock(); } catch {}
  try { writer?.releaseLock(); } catch {}
  try { await port?.close(); } catch {}
  reader = null;
  writer = null;
  port = null;
  readLoop = null;
  closing = false;
  connectButton.textContent = '연결';
  if (message) setStatus(message, true);
}

const FIRMWARE_MISSING = '해석기 펌웨어가 없습니다. 해석기 펌웨어 설치 버튼을 눌러 주세요';

async function connect() {
  if (!navigator.serial || flashing) return;
  if (port) {
    await disconnect();
    setStatus('연결을 끊었습니다.');
    return;
  }
  let selected;
  try { selected = await navigator.serial.requestPort(); }
  catch { return; }
  closing = false;
  try {
    await selected.open({ baudRate: 115200 });
  } catch (error) {
    setStatus(error.message || '포트를 열지 못했습니다.', true);
    return;
  }
  port = selected;
  try {
    await attachInterpreter();
  } catch {
    await disconnect(FIRMWARE_MISSING);
  }
}

async function runFlash(baud, image) {
  await openAt(baud);
  const io = createByteIo(port);
  try {
    await flashImage(io, image, (ratio) => {
      flashProgressBar.style.width = `${Math.max(0, Math.min(1, ratio)) * 100}%`;
    });
  } finally {
    await io.stop();
  }
}

async function installFirmware() {
  if (!navigator.serial || flashing) return;
  flashing = true;
  flashButton.disabled = true;
  let programming = false;
  try {
    if (!confirm('보드의 기존 프로그램이 지워지고 ArmBlocks 해석기로 바뀝니다. 서보 전원을 끄고 진행하세요.')) return;
    const response = await fetch('./firmware/armblocks_interpreter.hex');
    if (!response.ok) throw new Error('펌웨어 파일을 읽지 못했습니다');
    const image = parseIntelHex(await response.text());
    if (!port) {
      try { port = await navigator.serial.requestPort(); }
      catch { return; }
    }
    programming = true;
    flashProgress.hidden = false;
    flashProgressBar.style.width = '0%';
    setStatus('해석기 펌웨어를 설치하는 중입니다.');
    try {
      await runFlash(115200, image);
    } catch (error) {
      if (!error.sync) throw error;
      setStatus('57600으로 다시 시도하는 중입니다.');
      flashProgressBar.style.width = '0%';
      await runFlash(57600, image);
    }
    await openAt(115200);
    try {
      await attachInterpreter();
    } catch {
      await disconnect(FIRMWARE_MISSING);
    }
  } catch (error) {
    if (programming) {
      try { await pauseStreams(); } catch {}
      try { if (port?.readable || port?.writable) await port.close(); } catch {}
      port = null;
      connectButton.textContent = '연결';
    }
    setStatus(error.message || '펌웨어 설치에 실패했습니다.', true);
  } finally {
    flashing = false;
    flashButton.disabled = false;
    flashProgress.hidden = true;
  }
}

async function saveToBoard() {
  const result = currentProgram();
  if (!result.ok) {
    setStatus(result.error, true);
    return;
  }
  await enqueue(async () => {
    setStatus('보드에 저장하는 중입니다.');
    await request(`LOAD ${result.bytes.length}`, (line) => line === 'READY');
    if (result.bytes.length === 0) {
      const saved = await waitForLine((line) => line.startsWith('SAVED'), 3000);
      if (saved.startsWith('ERR') || saved.startsWith('STOPPED')) throw new Error(saved);
      setStatus('보드에 0바이트를 저장했습니다.');
      return;
    }
    for (let offset = 0; offset < result.bytes.length; offset += 64) {
      const chunk = result.bytes.subarray(offset, offset + 64);
      let hex = '';
      for (const value of chunk) hex += value.toString(16).toUpperCase().padStart(2, '0');
      const last = offset + chunk.length >= result.bytes.length;
      await request(hex, (line) => last ? line.startsWith('SAVED') : line.startsWith('OK'));
    }
    setStatus(`보드에 ${result.bytes.length}바이트를 저장했습니다.`);
  });
}

document.querySelector('#connectButton').addEventListener('click', () => {
  connect().catch((error) => setStatus(error.message, true));
});
flashButton.addEventListener('click', () => {
  installFirmware().catch((error) => setStatus(error.message, true));
});
document.querySelector('#saveBoardButton').addEventListener('click', () => {
  if (!port) return setStatus('먼저 보드를 연결하세요.', true);
  saveToBoard().catch((error) => setStatus(error.message, true));
});
document.querySelector('#runButton').addEventListener('click', () => {
  if (!port) return setStatus('먼저 보드를 연결하세요.', true);
  enqueue(() => request('RUN', (line) => line.includes('RUNNING'))).then(() => setStatus('프로그램을 실행합니다.')).catch((error) => setStatus(error.message, true));
});
document.querySelector('#stopButton').addEventListener('click', () => {
  if (!writer) return setStatus('먼저 보드를 연결하세요.', true);
  writeRaw('STOP').then(() => setStatus('정지를 보냈습니다.')).catch((error) => setStatus(error.message, true));
});
knobButton.addEventListener('click', () => {
  if (!port) return setStatus('먼저 보드를 연결하세요.', true);
  const next = !knobOn;
  const text = next ? 'KNOB ON' : 'KNOB OFF';
  enqueue(() => request(text, (line) => line.includes(next ? 'KNOB MODE ON' : 'KNOB MODE OFF')))
    .then(() => {
      knobOn = next;
      knobButton.textContent = knobOn ? '노브 비상모드 끄기' : '노브 비상모드';
      knobButton.classList.toggle('warn', knobOn);
      setStatus(knobOn ? '노브 비상모드입니다. 각 노브를 현재 각도에 맞춘 뒤 움직이세요.' : '노브 비상모드를 껐습니다.');
    })
    .catch((error) => setStatus(error.message, true));
});
document.querySelector('#autorunBox').addEventListener('change', (event) => {
  if (!port) {
    event.currentTarget.checked = false;
    setStatus('먼저 보드를 연결하세요.', true);
    return;
  }
  const enabled = event.currentTarget.checked;
  enqueue(() => request(`AUTORUN ${enabled ? 1 : 0}`, (line) => line.startsWith('AUTORUN')))
    .then(() => setStatus(enabled ? '전원을 켜면 저장된 프로그램을 실행합니다.' : '전원 켤 때 자동 실행을 껐습니다.'))
    .catch((error) => {
      event.currentTarget.checked = !enabled;
      setStatus(error.message, true);
    });
});

document.querySelector('#dismissNotice').addEventListener('click', () => document.querySelector('#notice').classList.add('hidden'));
document.querySelector('#clearLog').addEventListener('click', () => { serialLog.textContent = ''; });
document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => {
  document.querySelectorAll('.tab, .tab-page').forEach((item) => item.classList.remove('active'));
  tab.classList.add('active');
  document.querySelector(`#tab-${tab.dataset.tab}`).classList.add('active');
}));

function projectDocument() {
  return {
    format: 'armblocks-project',
    version: 1,
    savedAt: new Date().toISOString(),
    target: { fqbn: 'arduino:avr:uno', robot: 'Adeept ADA031-V4.0' },
    workspace: Blockly.serialization.workspaces.save(workspace)
  };
}

document.querySelector('#saveButton').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(projectDocument(), null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = '내 로봇팔.armblocks';
  link.click();
  URL.revokeObjectURL(url);
  setStatus('프로젝트 파일을 저장했습니다.');
});
document.querySelector('#openButton').addEventListener('click', () => document.querySelector('#fileInput').click());
document.querySelector('#fileInput').addEventListener('change', async (event) => {
  const file = event.currentTarget.files?.[0];
  event.currentTarget.value = '';
  if (!file) return;
  try {
    const documentData = JSON.parse(await file.text());
    if (documentData.format !== 'armblocks-project' || !documentData.workspace) throw new Error('ArmBlocks 프로젝트 형식이 아닙니다.');
    workspace.clear();
    Blockly.serialization.workspaces.load(documentData.workspace, workspace);
    rememberWorkspace();
    refreshCommands();
    setStatus('프로젝트를 열었습니다.');
  } catch (error) {
    setStatus(error.message || '파일을 열지 못했습니다.', true);
  }
});

window.addEventListener('resize', () => Blockly.svgResize(workspace));
