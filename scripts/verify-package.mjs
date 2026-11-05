/**
 * DualFlow Translator — 安装包校验脚本
 * 校验 ZIP 结构、CRX3 结构与 RSA 签名，并比对 dist 目录文件清单
 *
 * 用法： node scripts/verify-package.mjs
 */
import { createHash, createPublicKey, verify, createVerify } from 'node:crypto';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(ROOT, 'dist');

let failures = 0;
const ok = (label) => console.log(`  [PASS] ${label}`);
const fail = (label, detail) => {
  failures += 1;
  console.log(`  [FAIL] ${label}${detail ? ` -> ${detail}` : ''}`);
};

function findArtifact(ext) {
  const dir = readdirSync(DIST);
  const file = dir.find((name) => name.endsWith(ext));
  return file ? join(DIST, file) : null;
}

function walk(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, base, out);
    else out.push(full);
  }
  return out;
}

/* ---------------- ZIP 中央目录解析 ---------------- */
function readZipEntries(buffer) {
  const eocdIndex = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocdIndex < 0) throw new Error('未找到 EOCD 记录');
  const count = buffer.readUInt16LE(eocdIndex + 10);
  let offset = buffer.readUInt32LE(eocdIndex + 16);
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('中央目录签名错误');
    const method = buffer.readUInt16LE(offset + 10);
    const crc = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLen);
    entries.push({ name, method, crc, compressedSize, size, localOffset });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/* ---------------- protobuf 简易解析 ---------------- */
function parseVarint(buffer, pos) {
  let result = 0;
  let shift = 0;
  while (pos < buffer.length) {
    const byte = buffer[pos];
    pos += 1;
    result += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return [result, pos];
}

function parseProtoFields(buffer) {
  const fields = [];
  let pos = 0;
  while (pos < buffer.length) {
    let tag;
    [tag, pos] = parseVarint(buffer, pos);
    const wireType = tag & 0x7;
    const fieldNumber = tag >> 3;
    if (wireType === 2) {
      let len;
      [len, pos] = parseVarint(buffer, pos);
      fields.push({ fieldNumber, wireType, value: buffer.subarray(pos, pos + len) });
      pos += len;
    } else if (wireType === 0) {
      let value;
      [value, pos] = parseVarint(buffer, pos);
      fields.push({ fieldNumber, wireType, value });
    } else {
      break;
    }
  }
  return fields;
}

/* ---------------- 1. ZIP 校验 ---------------- */
console.log('\n[1/4] ZIP 包结构');
const zipPath = findArtifact('.zip');
if (!zipPath) {
  fail('ZIP 产物', 'dist 下未找到 .zip');
} else {
  const zipBuffer = readFileSync(zipPath);
  try {
    const entries = readZipEntries(zipBuffer);
    ok(`中央目录可解析，共 ${entries.length} 个条目`);
    const names = entries.map((e) => e.name);
    const required = ['manifest.json', 'icons/icon16.png', 'icons/icon48.png', 'icons/icon128.png', 'src/background/index.js', 'src/content/content.js', 'src/popup/popup.html', 'src/options/options.html'];
    const missing = required.filter((name) => !names.includes(name));
    if (missing.length === 0) ok('关键文件齐全');
    else fail('关键文件缺失', missing.join(', '));

    const stageDir = join(DIST, basename(zipPath).replace(/\.zip$/, ''));
    if (existsSync(stageDir)) {
      const diskFiles = walk(stageDir).map((f) => relative(stageDir, f).split('\\').join('/'));
      const onlyDisk = diskFiles.filter((f) => !names.includes(f));
      const onlyZip = names.filter((f) => !diskFiles.includes(f));
      if (onlyDisk.length === 0 && onlyZip.length === 0) ok('ZIP 与 dist 目录文件清单一致');
      else fail('清单不一致', `目录独有 ${onlyDisk.join(',')} / ZIP独有 ${onlyZip.join(',')}`);
    }
  } catch (error) {
    fail('ZIP 解析', error.message);
  }
}

/* ---------------- 2. CRX3 结构与签名 ---------------- */
console.log('\n[2/4] CRX3 包结构与 RSA 签名');
const crxPath = findArtifact('.crx');
if (!crxPath) {
  fail('CRX 产物', 'dist 下未找到 .crx');
} else {
  const crx = readFileSync(crxPath);
  const magic = crx.toString('binary', 0, 4);
  const version = crx.readUInt32LE(4);
  const headerSize = crx.readUInt32LE(8);
  if (magic === 'Cr24') ok('魔数 Cr24 正确');
  else fail('魔数', magic);
  if (version === 3) ok('版本号 3 (CRX3)');
  else fail('版本号', String(version));

  const header = crx.subarray(12, 12 + headerSize);
  const fields = parseProtoFields(header);
  const proofField = fields.find((f) => f.fieldNumber === 2);
  const signedHeaderField = fields.find((f) => f.fieldNumber === 10000);
  if (proofField && signedHeaderField) ok('CrxFileHeader 含 proofs 与 signed_header_data');
  else fail('CrxFileHeader 结构', JSON.stringify(fields.map((f) => f.fieldNumber)));

  const proofFields = parseProtoFields(proofField.value);
  const publicKeyField = proofFields.find((f) => f.fieldNumber === 1);
  const signatureField = proofFields.find((f) => f.fieldNumber === 2);
  if (publicKeyField && signatureField) ok('AsymmetricKeyProof 含公钥与签名');
  else fail('AsymmetricKeyProof 结构', proofFields.map((f) => f.fieldNumber).join(','));

  const signedHeaderData = signedHeaderField.value;
  const zipPart = crx.subarray(12 + headerSize);
  const sizeBuf = Buffer.alloc(4);
  sizeBuf.writeUInt32LE(signedHeaderData.length, 0);
  const signedData = Buffer.concat([
    Buffer.from('CRX3 SignedData\0', 'binary'),
    sizeBuf,
    signedHeaderData,
    zipPart,
  ]);
  const publicKey = createPublicKey({
    key: publicKeyField.value,
    format: 'der',
    type: 'spki',
  });
  const isValid = verify('sha256', signedData, publicKey, signatureField.value);
  if (isValid) ok('RSA-SHA256 签名验证通过（内容未被篡改）');
  else fail('RSA 签名验证', '签名不匹配');

  const tampered = Buffer.from(signedData);
  tampered[tampered.length - 10] ^= 0xff;
  const tamperOk = verify('sha256', tampered, publicKey, signatureField.value);
  if (!tamperOk) ok('篡改检测有效（改动 1 字节即验签失败）');
  else fail('篡改检测', '被篡改的数据仍能通过验签');

  try {
    const entries = readZipEntries(zipPart);
    ok(`CRX 内嵌 ZIP 可解析，共 ${entries.length} 个条目`);
  } catch (error) {
    fail('CRX 内嵌 ZIP', error.message);
  }
}

/* ---------------- 3. 清单完整性 ---------------- */
console.log('\n[3/4] manifest.json 与资源引用');
const stageDirName = zipPath ? basename(zipPath).replace(/\.zip$/, '') : 'dualflow-translator';
const stageDir = join(DIST, stageDirName);
if (existsSync(join(stageDir, 'manifest.json'))) {
  const manifest = JSON.parse(readFileSync(join(stageDir, 'manifest.json'), 'utf8'));
  const referenced = [
    manifest.background?.service_worker,
    manifest.action?.default_popup,
    manifest.options_ui?.page,
    ...(manifest.content_scripts || []).flatMap((cs) => [...(cs.js || []), ...(cs.css || [])]),
    ...Object.values(manifest.icons || {}),
    ...Object.values(manifest.action?.default_icon || {}),
  ].filter(Boolean);
  const missing = referenced.filter((rel) => !existsSync(join(stageDir, rel)));
  if (missing.length === 0) ok(`${referenced.length} 个引用资源全部存在`);
  else fail('引用资源缺失', missing.join(', '));

  if (manifest.manifest_version === 3) ok('manifest_version = 3');
  else fail('manifest_version', String(manifest.manifest_version));
} else {
  fail('dist manifest.json', '不存在');
}

/* ---------------- 4. 校验和清单 ---------------- */
console.log('\n[4/4] SHA256 校验和文件');
const shaPath = findArtifact('.sha256');
if (!shaPath) {
  fail('校验和文件', '未生成 .sha256');
} else {
  const lines = readFileSync(shaPath, 'utf8').trim().split('\n');
  let allMatch = true;
  for (const line of lines) {
    const [hash, file] = line.trim().split(/\s+/);
    const target = join(DIST, file);
    if (!existsSync(target)) {
      fail(file, '文件不存在');
      allMatch = false;
      continue;
    }
    const actual = createHash('sha256').update(readFileSync(target)).digest('hex');
    if (actual !== hash) {
      fail(file, '校验和不匹配');
      allMatch = false;
    }
  }
  if (allMatch) ok(`${lines.length} 条校验和全部匹配`);
}

console.log(`\n结果：${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
process.exit(failures === 0 ? 0 : 1);

