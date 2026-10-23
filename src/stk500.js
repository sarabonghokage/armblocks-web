const PAGE = 128;
const BOOT_ADDR = 0x7e00;
const INSYNC = 0x14;
const OK = 0x10;

export function parseIntelHex(text) {
  let highest = 0;
  const records = [];
  const lines = text.split(/\r?\n/);
  for (let lineNo = 0; lineNo < lines.length; lineNo += 1) {
    const line = lines[lineNo].trim();
    if (!line) continue;
    if (!line.startsWith(':') || line.length < 11 || (line.length - 1) % 2 !== 0) {
      throw new Error('Intel HEX 형식이 아닙니다');
    }
    const bytes = new Uint8Array((line.length - 1) / 2);
    for (let index = 0; index < bytes.length; index += 1) {
      const pair = line.slice(1 + index * 2, 3 + index * 2);
      const value = Number.parseInt(pair, 16);
      if (!/^[0-9a-fA-F]{2}$/.test(pair) || !Number.isFinite(value)) {
        throw new Error('Intel HEX 형식이 아닙니다');
      }
      bytes[index] = value;
    }
    const count = bytes[0];
    if (bytes.length !== count + 5) throw new Error('Intel HEX 형식이 아닙니다');
    let sum = 0;
    for (const value of bytes) sum = (sum + value) & 0xff;
    if (sum !== 0) throw new Error(`체크섬이 틀립니다 (${lineNo + 1}줄)`);
    const type = bytes[3];
    if (type === 0x01) break;
    if (type === 0x02 || type === 0x04) continue;
    if (type !== 0x00) throw new Error('Intel HEX 형식이 아닙니다');
    const addr = (bytes[1] << 8) | bytes[2];
    if (addr >= BOOT_ADDR || addr + count > BOOT_ADDR) throw new Error('부트로더 영역은 쓸 수 없습니다');
    records.push({ addr, data: bytes.subarray(4, 4 + count) });
    if (addr + count > highest) highest = addr + count;
  }
  const length = Math.ceil(highest / PAGE) * PAGE;
  const image = new Uint8Array(length);
  image.fill(0xff);
  for (const record of records) image.set(record.data, record.addr);
  return image;
}

function hexOf(bytes) {
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join(' ');
}

function matches(bytes, expected) {
  if (bytes.length !== expected.length) return false;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== expected[index]) return false;
  }
  return true;
}

async function discardPending(io) {
  const deadline = Date.now() + 40;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) return;
    try {
      await io.read(1, Math.min(20, left));
    } catch (error) {
      if (error.timeout) return;
      throw error;
    }
  }
}

async function sync(io) {
  let last = '응답 시간 초과';
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await discardPending(io);
      await io.write(new Uint8Array([0x30, 0x20]));
      const got = await io.read(2, 200);
      if (matches(got, [INSYNC, OK])) {
        await io.sleep(60);
        await discardPending(io);
        await io.write(new Uint8Array([0x30, 0x20]));
        const confirm = await io.read(2, 300);
        if (matches(confirm, [INSYNC, OK])) {
          await io.sleep(30);
          await discardPending(io);
          return;
        }
        last = `예상과 다른 응답 ${hexOf(confirm)}`;
        await discardPending(io);
        continue;
      }
      last = `예상과 다른 응답 ${hexOf(got)}`;
      await discardPending(io);
    } catch (error) {
      if (!error.timeout) {
        const wrapped = new Error(`동기화 실패: ${error.message}`);
        wrapped.sync = true;
        throw wrapped;
      }
      last = error.message;
    }
  }
  const error = new Error(`동기화 실패: ${last}`);
  error.sync = true;
  throw error;
}

async function exchange(io, bytes, expected, step) {
  try {
    await io.write(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  } catch (error) {
    throw new Error(`${step} 실패: ${error.message}`);
  }
  let got;
  try {
    got = await io.read(expected.length, 1000);
  } catch (error) {
    throw new Error(`${step} 실패: ${error.message}`);
  }
  if (!matches(got, expected)) throw new Error(`${step} 실패: 예상과 다른 응답 ${hexOf(got)}`);
}

export async function flashImage(io, image, onProgress) {
  await io.setSignals({ dataTerminalReady: false, requestToSend: false });
  await io.sleep(250);
  await io.setSignals({ dataTerminalReady: true, requestToSend: true });
  await io.sleep(50);
  await sync(io);
  try {
    await io.write(new Uint8Array([0x75, 0x20]));
  } catch (error) {
    throw new Error(`서명 확인 실패: ${error.message}`);
  }
  let sign;
  try {
    sign = await io.read(5, 1000);
  } catch (error) {
    throw new Error(`서명 확인 실패: ${error.message}`);
  }
  if (!matches(sign, [INSYNC, 0x1e, 0x95, 0x0f, OK])) {
    throw new Error(`ATmega328P 보드가 아닙니다 (받은 값: ${hexOf(sign)})`);
  }
  await exchange(io, [0x50, 0x20], [INSYNC, OK], '프로그래밍 모드');
  const pages = Math.ceil(image.length / PAGE);
  for (let page = 0; page < pages; page += 1) {
    const offset = page * PAGE;
    const word = offset >> 1;
    await exchange(io, [0x55, word & 0xff, (word >> 8) & 0xff, 0x20], [INSYNC, OK], '주소 설정');
    const command = new Uint8Array(4 + PAGE + 1);
    command[0] = 0x64;
    command[1] = 0x00;
    command[2] = 0x80;
    command[3] = 0x46;
    const slice = image.subarray(offset, Math.min(offset + PAGE, image.length));
    command.set(slice, 4);
    if (slice.length < PAGE) command.fill(0xff, 4 + slice.length, 4 + PAGE);
    command[4 + PAGE] = 0x20;
    await exchange(io, command, [INSYNC, OK], '페이지 쓰기');
    if (onProgress) onProgress((page + 1) / pages * 0.5);
  }
  for (let page = 0; page < pages; page += 1) {
    const offset = page * PAGE;
    const word = offset >> 1;
    await exchange(io, [0x55, word & 0xff, (word >> 8) & 0xff, 0x20], [INSYNC, OK], '주소 설정');
    try {
      await io.write(new Uint8Array([0x74, 0x00, 0x80, 0x46, 0x20]));
    } catch (error) {
      throw new Error(`페이지 읽기 실패: ${error.message}`);
    }
    let got;
    try {
      got = await io.read(PAGE + 2, 1000);
    } catch (error) {
      throw new Error(`페이지 읽기 실패: ${error.message}`);
    }
    if (got.length !== PAGE + 2 || got[0] !== INSYNC || got[PAGE + 1] !== OK) {
      throw new Error(`페이지 읽기 실패: 예상과 다른 응답 ${hexOf(got)}`);
    }
    for (let index = 0; index < PAGE; index += 1) {
      const expected = offset + index < image.length ? image[offset + index] : 0xff;
      if (got[index + 1] !== expected) throw new Error('검증 실패');
    }
    if (onProgress) onProgress(0.5 + (page + 1) / pages * 0.5);
  }
  if (pages === 0 && onProgress) onProgress(1);
  await exchange(io, [0x51, 0x20], [INSYNC, OK], '종료');
}
