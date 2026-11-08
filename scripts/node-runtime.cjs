const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function prepareNodeRuntime(target, source = process.execPath) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // Windows locks running executables. Keep a usable installed sidecar instead
  // of replacing it with whichever Node happens to be on the caller's PATH.
  if (!fs.existsSync(target)) {
    try {
      fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  let version;
  try {
    version = execFileSync(target, ['--version'], {
      encoding: 'utf8', windowsHide: true, timeout: 10000,
    }).trim();
  } catch (error) {
    throw new Error(`Node sidecar tidak dapat dijalankan: ${target}. Tutup SOCL sebelum memperbaiki runtime tersebut.`, { cause: error });
  }
  if (!/^v(\d+)\./.test(version) || Number(version.match(/^v(\d+)\./)[1]) < 18) {
    throw new Error(`Node sidecar membutuhkan Node 18 atau lebih baru; ditemukan ${version}: ${target}`);
  }
  return version;
}

module.exports = { prepareNodeRuntime };
