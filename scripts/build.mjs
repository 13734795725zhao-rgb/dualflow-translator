/**
 * DualFlow Translator — 打包脚本（零依赖，仅用 Node 内置模块）
 *
 * 产出：
 *   dist/dualflow-translator-v<版本>/              解压即可「加载已解压的扩展程序」
 *   dist/dualflow-translator-v<版本>.zip           Chrome Web Store 上传包 / 归档包
 *   dist/dualflow-translator-v<版本>.crx           自签名 CRX3 本地安装包
 *   dist/dualflow-translator-v<版本>.sha256        校验和清单
 *
 * 用法： node scripts/build.mjs
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { createHash, generateKeyPairSync, sign, createPublicKey } from 'node:crypto';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(ROOT, 'dist');
const KEY_DIR = join(ROOT, '.keys');

/* ---------------- 工具 ---------------- */
function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/* ---------------- 极简 ZIP 写入器（deflate，无第三方依赖） ---------------- */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

function dosDateTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (Math.floor(date.getSeconds() / 2) & 0x1f);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

/**
 * @param {Array<{name:string, data:Buffer}>} entries
 * @returns {Buffer} ZIP 文件内容
 */
function createZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const { time, day } = dosDateTime(new Date());

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name.split(sep).join('/'), 'utf8');
    const data = entry.data;
    const compressed = deflateRawSync(data, { level: 9 });
    const useStore = compressed.length >= data.length;
    const payload = useStore ? data : compressed;
    const method = useStore ? 0 : 8;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 文件名标志位
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    chunks.push(local, nameBuf, payload);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt16LE(time, 12);
    dir.writeUInt16LE(day, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(payload.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt16LE(0, 30);
    dir.writeUInt16LE(0, 32);
    dir.writeUInt16LE(0, 34);
    dir.writeUInt16LE(0, 36);
    dir.writeUInt32LE(0, 38);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBuf);

    offset += local.length + nameBuf.length + payload.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, centralBuf, end]);
}

/* ---------------- CRX3 封装 ---------------- */
function varint(value) {
  const bytes = [];
  let remaining = value;
  do {
    let byte = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
    if (remaining > 0) byte |= 0x80;
    bytes.push(byte);
  } while (remaining > 0);
  return Buffer.from(bytes);
}

function protobufBytes(tag, payload) {
  return Buffer.concat([varint((tag << 3) | 2), varint(payload.length), payload]);
}

/**
 * 生成 CRX3（RSA / SHA-256 自签名）
 * 结构：Cr24 | version=3 | headerSize | CrxFileHeader | zip
 */
function createCrx3(zipBuffer, privateKeyPem) {
  const publicDer = createPublicKey(privateKeyPem).export({ type: 'spki', format: 'der' });

  // 内层 signed_header_data：proof 只含公钥（签名字段留空，避免自引用循环）
  const innerProof = protobufBytes(2, protobufBytes(1, publicDer));
  const signedHeaderData = Buffer.concat([innerProof]);

  // 签名数据 = "CRX3 SignedData\0" + u32(len) + signed_header_data + zip
  const sizeBuf = Buffer.alloc(4);
  sizeBuf.writeUInt32LE(signedHeaderData.length, 0);
  const signedData = Buffer.concat([
    Buffer.from('CRX3 SignedData\0', 'binary'),
    sizeBuf,
    signedHeaderData,
    zipBuffer,
  ]);

  const signature = sign('sha256', signedData, privateKeyPem);

  // 外层头：proof 含公钥 + 签名，并携带 signed_header_data
  const outerProof = protobufBytes(
    2,
    Buffer.concat([protobufBytes(1, publicDer), protobufBytes(2, signature)]),
  );
  const outerHeader = Buffer.concat([outerProof, protobufBytes(10000, signedHeaderData)]);

  const magic = Buffer.from('Cr24', 'binary');
  const version = Buffer.alloc(4);
  version.writeUInt32LE(3, 0);
  const headerSize = Buffer.alloc(4);
  headerSize.writeUInt32LE(outerHeader.length, 0);

  return Buffer.concat([magic, version, headerSize, outerHeader, zipBuffer]);
}

/* ---------------- 主流程 ---------------- */
/** 手动递归拷贝（规避 Windows 下 fs.cpSync 在非 ASCII 路径上的原生崩溃） */
function copyDir(from, to) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from)) {
    const src = join(from, entry);
    const dest = join(to, entry);
    if (statSync(src).isDirectory()) copyDir(src, dest);
    else writeFileSync(dest, readFileSync(src));
  }
}

function build() {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
  const version = manifest.version || '1.0.0';
  const name = `dualflow-translator-v${version}`;

  // 1. 清理 dist
  rmSync(DIST, { recursive: true, force: true });
  mkdirSync(DIST, { recursive: true });

  // 2. 拷贝需要打包的文件
  const stageDir = join(DIST, name);
  mkdirSync(stageDir, { recursive: true });
  cpSync(join(ROOT, 'manifest.json'), join(stageDir, 'manifest.json'));
  copyDir(join(ROOT, 'src'), join(stageDir, 'src'));
  copyDir(join(ROOT, 'icons'), join(stageDir, 'icons'));
  if (existsSync(join(ROOT, 'README.md'))) {
    cpSync(join(ROOT, 'README.md'), join(stageDir, 'README.md'));
  }

  // 3. 校验 manifest 引用的资源都在
  const referenced = [
    manifest.background?.service_worker,
    manifest.action?.default_popup,
    manifest.options_ui?.page,
    ...(manifest.content_scripts || []).flatMap((cs) => [...(cs.js || []), ...(cs.css || [])]),
    ...Object.values(manifest.icons || {}),
    ...Object.values(manifest.action?.default_icon || {}),
  ].filter(Boolean);
  const missing = referenced.filter((rel) => !existsSync(join(stageDir, rel)));
  if (missing.length > 0) {
    console.error('[build] 缺少资源：', missing.join(', '));
    process.exit(1);
  }

  // 4. 生成 ZIP
  const files = walk(stageDir);
  const entries = files.map((file) => ({
    name: relative(stageDir, file),
    data: readFileSync(file),
  }));
  const zipBuffer = createZip(entries);
  const zipPath = join(DIST, `${name}.zip`);
  writeFileSync(zipPath, zipBuffer);

  // 5. 生成 CRX3（自签名密钥保存在 .keys/，不进入安装包）
  mkdirSync(KEY_DIR, { recursive: true });
  const keyPath = join(KEY_DIR, 'dualflow-local.pem');
  let privateKeyPem;
  if (existsSync(keyPath)) {
    privateKeyPem = readFileSync(keyPath);
  } else {
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    privateKeyPem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
    writeFileSync(keyPath, privateKeyPem, { mode: 0o600 });
  }
  const crxBuffer = createCrx3(zipBuffer, privateKeyPem);
  const crxPath = join(DIST, `${name}.crx`);
  writeFileSync(crxPath, crxBuffer);

  // 6. 校验和清单
  const checksums = [
    `${sha256(zipBuffer)}  ${name}.zip`,
    `${sha256(crxBuffer)}  ${name}.crx`,
  ].join('\n');
  writeFileSync(join(DIST, `${name}.sha256`), `${checksums}\n`, 'utf8');

  console.log('[build] 完成');
  console.log(`  目录   : ${relative(ROOT, stageDir)}`);
  console.log(`  ZIP    : ${relative(ROOT, zipPath)}  (${(zipBuffer.length / 1024).toFixed(1)} KB)`);
  console.log(`  CRX3   : ${relative(ROOT, crxPath)}  (${(crxBuffer.length / 1024).toFixed(1)} KB)`);
  console.log(`  文件数 : ${entries.length}`);
}

build();
