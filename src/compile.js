function fieldValue(block, name) {
  const value = block?.fields?.[name];
  if (value && typeof value === 'object' && 'value' in value) return value.value;
  return value;
}

function clampInt(value, min, max, fallback) {
  let number = Math.round(Number(value));
  if (!Number.isFinite(number)) number = fallback;
  if (number < min) return min;
  if (number > max) return max;
  return number;
}

function childBlock(node) {
  return node?.block || null;
}

function pushByte(out, value) {
  out.push(value & 0xff);
  return out.length <= 1000;
}

function appendChain(block, out, depth) {
  let current = block;
  while (current) {
    const skipped = current.enabled === false
      || (Array.isArray(current.disabledReasons) && current.disabledReasons.length > 0);
    if (!skipped) {
      const error = appendBlock(current, out, depth);
      if (error) return error;
    }
    current = childBlock(current.next);
  }
  return null;
}

function appendBlock(block, out, depth) {
  switch (block.type) {
    case 'arm_speed':
      return pushByte(out, 0x01) && pushByte(out, clampInt(fieldValue(block, 'SPEED'), 5, 180, 45))
        ? null
        : '프로그램이 너무 깁니다';
    case 'arm_move':
      return pushByte(out, 0x02)
        && pushByte(out, clampInt(fieldValue(block, 'SERVO'), 0, 4, 0))
        && pushByte(out, clampInt(fieldValue(block, 'ANGLE'), 0, 180, 90))
        ? null
        : '프로그램이 너무 깁니다';
    case 'arm_pose': {
      if (!pushByte(out, 0x03)) return '프로그램이 너무 깁니다';
      const defaults = [90, 90, 90, 110, 90];
      for (let index = 0; index < 5; index += 1) {
        if (!pushByte(out, clampInt(fieldValue(block, `A${index}`), 0, 180, defaults[index]))) {
          return '프로그램이 너무 깁니다';
        }
      }
      return null;
    }
    case 'arm_home':
      return pushByte(out, 0x04) ? null : '프로그램이 너무 깁니다';
    case 'arm_wait': {
      const tenths = clampInt(Number(fieldValue(block, 'SECONDS')) * 10, 0, 65535, 0);
      return pushByte(out, 0x05) && pushByte(out, tenths & 0xff) && pushByte(out, (tenths >> 8) & 0xff)
        ? null
        : '프로그램이 너무 깁니다';
    }
    case 'arm_repeat': {
      if (depth >= 4) return '반복은 4단까지만 넣을 수 있습니다';
      const count = clampInt(fieldValue(block, 'COUNT'), 1, 100, 1);
      if (!pushByte(out, 0x06) || !pushByte(out, count)) return '프로그램이 너무 깁니다';
      const error = appendChain(childBlock(block.inputs?.DO), out, depth + 1);
      if (error) return error;
      return pushByte(out, 0x07) ? null : '프로그램이 너무 깁니다';
    }
    case 'arm_knob': {
      const mode = fieldValue(block, 'MODE');
      const enabled = mode === true || mode === 'true' ? 1 : 0;
      return pushByte(out, 0x08) && pushByte(out, enabled) ? null : '프로그램이 너무 깁니다';
    }
    case 'arm_print': {
      const encoded = new TextEncoder().encode(String(fieldValue(block, 'TEXT') ?? ''));
      let length = Math.min(60, encoded.length);
      while (length > 0 && (encoded[length] & 0xc0) === 0x80) length -= 1;
      if (!pushByte(out, 0x09) || !pushByte(out, length)) return '프로그램이 너무 깁니다';
      for (let index = 0; index < length; index += 1) {
        if (!pushByte(out, encoded[index])) return '프로그램이 너무 깁니다';
      }
      return null;
    }
    default:
      return '알 수 없는 블록입니다';
  }
}

export function compileWorkspace(json) {
  const blocks = json?.blocks?.blocks;
  const start = Array.isArray(blocks) ? blocks.find((block) => block?.type === 'arm_start') : null;
  if (!start) return { ok: false, error: '시작 블록이 없습니다' };
  const out = [];
  const error = appendChain(childBlock(start.inputs?.DO), out, 0);
  if (error) return { ok: false, error };
  if (out.length > 1000) return { ok: false, error: '프로그램이 너무 깁니다' };
  return { ok: true, bytes: new Uint8Array(out) };
}
