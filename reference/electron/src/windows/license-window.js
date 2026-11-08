// Renderer-side logic for the license activation popup.
// Communicates with main process via IPC (see main-integration.js).

// Wire up purchase link → open in external browser
const purchaseLink = document.getElementById('purchase-link');
if (purchaseLink) {
  purchaseLink.addEventListener('click', (e) => {
    e.preventDefault();
    window.licenseAPI.openPurchase();
  });
}

const emailInput = document.getElementById('email');
const licenseInput = document.getElementById('license');
const activateBtn = document.getElementById('activate-btn');
const messageEl = document.getElementById('message');

const ERROR_MESSAGES = {
  license_not_found: 'License key tidak ditemukan. Pastikan key benar.',
  email_mismatch: 'Email tidak cocok dengan license key.',
  license_revoked: 'License ini sudah dinonaktifkan. Hubungi support.',
  machine_blocked: 'Perangkat ini sudah diblokir. Hubungi support.',
  already_bound_other_machine: 'License sudah aktif di device lain. Hubungi support untuk pindah device.',
  missing_fields: 'Email dan license key wajib diisi.',
  unauthorized: 'Konfigurasi tidak valid. Hubungi support.',
  // [LICENSE-CFG-CANON] Distinct from 'unauthorized': this build never sent a
  // real secret at all (packaging bug, see build-secure.js), so telling the
  // user their key/email is wrong or the SERVER's config is bad would send
  // them chasing the wrong thing. This points at the actual fix: reinstall.
  license_config_missing: 'Build aplikasi ini rusak (konfigurasi lisensi tidak ikut terpasang). Unduh ulang installer terbaru dari halaman download.',
  invalid_json_response: 'Server tidak merespons dengan benar. Coba lagi.',
  timeout: 'Koneksi timeout. Periksa internet Anda.',
  network: 'Tidak bisa menghubungi server. Periksa koneksi internet.',
  // [NET-RETRY] A transport failure that retrying cannot fix. An antivirus or
  // company proxy re-signing HTTPS makes the server's certificate unverifiable
  // — the same class of problem that moved this app onto Chromium's network
  // stack in the first place. Point at that, not at the internet connection.
  network_cert: 'Koneksi ke server diblokir (sertifikat tidak dipercaya). Biasanya karena antivirus atau proxy kantor yang memindai HTTPS — matikan sementara fitur "HTTPS/SSL scanning"-nya, lalu coba lagi.',
};

function showMessage(text, type) {
  messageEl.textContent = text;
  messageEl.className = 'message ' + type;
}

function clearMessage() {
  messageEl.className = 'message';
  messageEl.textContent = '';
}

// Auto-format license key: XXXXX-XXXXX-XXXXX-XXXXX-XXXXX
licenseInput.addEventListener('input', (e) => {
  let v = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const groups = [];
  for (let i = 0; i < v.length && groups.length < 5; i += 5) {
    groups.push(v.slice(i, i + 5));
  }
  e.target.value = groups.join('-');
});

async function activate() {
  const email = emailInput.value.trim();
  const licenseKey = licenseInput.value.trim().toUpperCase();

  if (!email || !email.includes('@')) {
    showMessage('Masukkan email yang valid.', 'error');
    return;
  }
  if (licenseKey.length < 25) {
    showMessage('License key tidak lengkap.', 'error');
    return;
  }

  activateBtn.disabled = true;
  activateBtn.textContent = 'Activating...';
  clearMessage();

  try {
    const res = await window.licenseAPI.activate(email, licenseKey);
    if (res.ok) {
      showMessage('Aktivasi berhasil! Membuka aplikasi...', 'success');
      setTimeout(() => window.licenseAPI.notifyActivated(), 800);
    } else {
      const msg = ERROR_MESSAGES[res.error] || `Aktivasi gagal: ${res.error}`;
      showMessage(msg, 'error');
      activateBtn.disabled = false;
      activateBtn.textContent = 'Activate';
    }
  } catch (err) {
    showMessage(ERROR_MESSAGES.network, 'error');
    activateBtn.disabled = false;
    activateBtn.textContent = 'Activate';
  }
}

activateBtn.addEventListener('click', activate);

licenseInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') activate();
});
emailInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') licenseInput.focus();
});

emailInput.focus();
