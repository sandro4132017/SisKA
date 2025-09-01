// index.js — SisKA Bot (whatsapp-web.js)
// -------------------------------------------------------------
// Fitur utama:
// 1) Log IN/OUT ke terminal & file per chat
// 2) Ketik (typing) + jeda 1–3 detik sebelum kirim balasan
// 3) Alur INTERNAL: Menu (1 Lembur, 2 Cuti, 3 Helpdesk)
//    - Minta alasan -> kirim ke atasan -> atasan APPROVE/REJECT via QUOTE REPLY
//    - Setelah approve: balas ke pegawai + link form sesuai jenis
// 4) Alur EKSTERNAL: Minta identitas -> minta pertanyaan -> forward ke grup helpdesk
//    - Grup jawab via QUOTE REPLY pada instruksi -> bot forward balik ke user
//    - Follow-up: selesai / pertanyaan lanjutan / minta dijadwalkan
// -------------------------------------------------------------

console.log('[INIT] Memulai bot SisKA...');

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');

const { HELPDESK_GROUP_ID, FORM_LEMBUR_URL, FORM_CUTI_URL } = require('./config');

// ====== STATE ======
let dbPegawai = [];
// Map alur pengajuan per pengirim (pegawai)
const pengajuanBySender = {}; // { senderId: { step, jenis, alasan, pegawai, atasan } }
// Map id pesan yang dikirim ke atasan -> data pengajuan (untuk quote reply approval)
const pengajuanByAtasanMsgId = {}; // { quotedMsgId: { sender, jenis, pegawai, atasan } }

// Helpdesk state per user (eksternal atau via menu 3)
const helpdeskQueue = {}; // { senderId: { step, namaUnit? } }
// Map id instruksi yang dipost di grup -> nomor user tujuan
const helpdeskInstruksiMap = {}; // { quotedMsgId: targetUserId }

// ====== UTIL LOGGING ======
function ts() { return new Date().toISOString(); }
function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }
function logToFile(numberOrName, type, text) {
  const dir = path.join(__dirname, 'logs');
  ensureDir(dir);
  const logFile = path.join(dir, `${numberOrName}.log`);
  const line = `[${ts()}] [${type}] ${text}\n`;
  fs.appendFileSync(logFile, line);
}

// Log ke terminal untuk setiap pesan masuk/keluar
function logIn(chatId, body) {
  console.log(`[MASUK] ${ts()} | Dari: ${chatId} | Pesan: ${body}`);
  logToFile(chatId, 'MASUK', body);
}
function logOut(chatId, body) {
  console.log(`[KELUAR] ${ts()} | Ke: ${chatId} | Pesan: ${body}`);
  logToFile(chatId, 'KELUAR', body);
}

// ====== BACA DATABASE ======
try {
  const dbPath = path.join(__dirname, 'database Pegawai Biro keuangan.json');
  const raw = fs.readFileSync(dbPath, 'utf8');
  const parsed = JSON.parse(raw);
  dbPegawai = parsed.Internal || [];
  console.log(`[INIT] Berhasil memuat ${dbPegawai.length} data pegawai.`);
} catch (err) {
  console.error('[CRITICAL] Gagal membaca database pegawai:', err.message);
  console.error('Pastikan file JSON dan struktur key sudah benar (Internal[...]).');
}

// ====== HELPER ======
function hanyaAngka(id) { return (id || '').replace(/[^0-9]/g, ''); }
function isApprovalYes(text) {
  const t = (text || '').trim().toLowerCase();
  return t === '1' || t === 'setuju' || t === 'ya' || t === 'y' || t.includes('setuju') || t.includes('approve');
}
function isApprovalNo(text) {
  const t = (text || '').trim().toLowerCase();
  return t === '2' || t === 'tidak' || t === 'ga' || t === 'gak' || t.includes('tolak') || t.includes('reject');
}

function cariPegawaiByWa(waNumberDigits) {
  if (!Array.isArray(dbPegawai)) return null;
  // DB menyimpan nomor seperti 6285xxxx tanpa @c.us
  return dbPegawai.find(p => (p['No. HP (WA) aktif'] || '') === waNumberDigits) || null;
}

function cariAtasanPegawai(pegawai) {
  if (!pegawai) return null;
  return dbPegawai.find(p => p['No. HP (WA) aktif'] === pegawai['NO HP ATASAN']) || null;
}

async function kirimDenganTyping(client, chatId, text) {
  try {
    const chat = await client.getChatById(chatId);
    await chat.sendStateTyping(); // wwebjs Chat#sendStateTyping()
    const delay = Math.floor(Math.random() * 2000) + 1000; // 1–3s
    await new Promise(r => setTimeout(r, delay));
    await chat.clearState();
    await client.sendMessage(chatId, text);
    logOut(chatId, text);
  } catch (e) {
    console.error(`[ERROR] Gagal kirim ke ${chatId}:`, e.message);
  }
}

// ====== INIT CLIENT ======
const client = new Client({ authStrategy: new LocalAuth() });

client.on('qr', qr => {
  qrcode.generate(qr, { small: true });
  console.log('[QR] Tersedia. Scan ya brad.');
});

client.on('ready', () => console.log('✅ [READY] Bot SisKA siap Broer! 🚀'));
client.on('disconnected', reason => console.log(`[WA] Bot disconnect: ${reason}`));

// ====== MESSAGE HANDLER ======
client.on('message', async (message) => {
  try {
    const chatId = message.from; // bisa @c.us atau @g.us
    const isGroup = chatId.endsWith('@g.us');
    const digits = hanyaAngka(chatId);

    logIn(chatId, message.body);

    // ----- 0) Handler dari grup (helpdesk & approval via quote) -----
    if (isGroup) {
      // Helpdesk reply oleh tim via quote pada INSTRUKSI
      if (chatId === HELPDESK_GROUP_ID && message.hasQuotedMsg) {
        try {
          const quoted = await message.getQuotedMessage();
          const key = quoted.id._serialized;
          const targetUser = helpdeskInstruksiMap[key];
          if (targetUser) {
            const balasan = `Halo, berikut jawaban dari Helpdesk:\n\n${message.body}`;
            await kirimDenganTyping(client, targetUser, balasan);

            const followup =
`Apakah jawaban dari Helpdesk sudah membantu?\n\n`+
`Ketik *selesai* jika sudah.\n`+
`Atau pilih:\n1. Ajukan pertanyaan lanjutan\n2. Jadwalkan konsultasi di Biro Keuangan dan BMN`;
            await kirimDenganTyping(client, targetUser, followup);

            helpdeskQueue[targetUser] = { step: 'followup' };
            await kirimDenganTyping(client, HELPDESK_GROUP_ID, `✅ Jawaban sudah diteruskan ke ${targetUser}`);
            return;
          }
        } catch {}
      }
      // Tidak ada handler grup lain → keluar
      return;
    }

    // ----- 1) Handler approval atasan via quote reply -----
    if (message.hasQuotedMsg) {
      try {
        const quoted = await message.getQuotedMessage();
        const qid = quoted.id._serialized;
        const pengajuan = pengajuanByAtasanMsgId[qid];
        if (pengajuan) {
          const pemohonId = pengajuan.sender;
          const jenis = pengajuan.jenis; // 'Lembur' atau 'Cuti'

          if (isApprovalYes(message.body)) {
            let pesanPegawai = `✅ Pengajuan ${jenis} Anda telah *DISETUJUI* oleh atasan.`;
            if (jenis === 'Lembur') {
              pesanPegawai += `\n\nSilakan lanjutkan isi form laporan hasil lembur di link berikut:\n${FORM_LEMBUR_URL}`;
            } else if (jenis === 'Cuti') {
              pesanPegawai += `\n\nSilakan lanjutkan mengisi form pengajuan cuti di link berikut:\n${FORM_CUTI_URL}`;
            }
            await kirimDenganTyping(client, pemohonId, pesanPegawai);
            await kirimDenganTyping(client, chatId, `[APPROVAL] ✅ Disetujui untuk ${pengajuan.pegawai['Nama Pegawai']}`);
          } else if (isApprovalNo(message.body)) {
            await kirimDenganTyping(client, pemohonId, `❌ Pengajuan ${jenis} Anda *DITOLAK* oleh atasan.`);
            await kirimDenganTyping(client, chatId, `[APPROVAL] ❌ Ditolak untuk ${pengajuan.pegawai['Nama Pegawai']}`);
          } else {
            await kirimDenganTyping(client, chatId, 'Balas dengan *1 (Setuju)* atau *2 (Tidak Setuju)* ya.');
            return;
          }

          // bersihkan map setelah keputusan
          delete pengajuanByAtasanMsgId[qid];
          return;
        }
      } catch {}
    }

    // ----- 2) Tentukan internal vs eksternal -----
    const pegawai = cariPegawaiByWa(digits);

    // ========== EKSTERNAL ==========
    if (!pegawai || helpdeskQueue[chatId]) {
      if (!helpdeskQueue[chatId]) {
        const welcome =
`Halo, terima kasih sudah menghubungi Helpdesk Biro Keuangan dan BMN. 🙏\n\n`+
`Mohon sebutkan identitas Anda:\n1. Nama Lengkap\n2. Jabatan\n3. Unit Kerja`;
        await kirimDenganTyping(client, chatId, welcome);
        helpdeskQueue[chatId] = { step: 'identitas' };
        return;
      }

      const state = helpdeskQueue[chatId];
      if (state.step === 'identitas') {
        await kirimDenganTyping(client, chatId, 'Terima kasih. Silakan tuliskan pertanyaan Anda.');
        state.step = 'pertanyaan';
        return;
      }

      if (state.step === 'pertanyaan') {
        // teruskan ke grup helpdesk (dua pesan: pertanyaan + instruksi)
        const pertanyaan = `Halo tim Helpdesk, ada pertanyaan dari user eksternal:\nIdentitas: ${message._data.notifyName || 'User'} (${chatId})\nPertanyaan: ${message.body}`;
        const instruksi = `Balas pertanyaan di atas dengan *QUOTE REPLY pesan ini*.\nBot akan meneruskan jawaban Anda ke ${chatId}.`;

        await kirimDenganTyping(client, HELPDESK_GROUP_ID, pertanyaan);
        const instruksiMsg = await client.sendMessage(HELPDESK_GROUP_ID, instruksi); // sengaja tanpa typing kedua agar berurutan
        logOut(HELPDESK_GROUP_ID, instruksi);

        // simpan mapping quoted-msg-id -> user
        helpdeskInstruksiMap[instruksiMsg.id._serialized] = chatId;

        await kirimDenganTyping(client, chatId, 'Pertanyaan Anda sudah diteruskan ke tim Helpdesk. Mohon tunggu jawaban dari kami.');
        state.step = 'menunggu-jawaban';
        return;
      }

      if (state.step === 'followup') {
        const t = message.body.trim().toLowerCase();
        if (t.includes('selesai')) {
          await kirimDenganTyping(client, chatId, 'Terima kasih telah menggunakan layanan BOT Layanan TU. Jika ada pertanyaan lain, silakan hubungi kami kembali.');
          delete helpdeskQueue[chatId];
          return;
        }
        if (t === '1') {
          await kirimDenganTyping(client, chatId, 'Silakan tuliskan pertanyaan lanjutan Anda untuk Helpdesk.');
          state.step = 'pertanyaan';
          return;
        }
        if (t === '2') {
          await kirimDenganTyping(client, chatId, 'Silakan tuliskan waktu/jadwal yang Anda inginkan untuk konsultasi. Tim kami akan segera menghubungi Anda.');
          state.step = 'jadwal';
          return;
        }
        await kirimDenganTyping(client, chatId, 'Pilihan tidak valid. Ketik *selesai* atau pilih: 1. Pertanyaan lanjutan  2. Jadwalkan konsultasi');
        return;
      }

      if (state.step === 'jadwal') {
        await kirimDenganTyping(client, chatId, 'Terima kasih, permintaan jadwal Anda sudah kami terima. Tim kami akan segera menghubungi Anda.');
        const notif = `📅 Permintaan jadwal konsultasi dari ${chatId}:\n${message.body}`;
        await kirimDenganTyping(client, HELPDESK_GROUP_ID, notif);
        delete helpdeskQueue[chatId];
        return;
      }

      // default eksternal
      return;
    }

    // ========== INTERNAL ==========
    // jika belum ada alur atau user mengetik "menu", tampilkan menu utama
    const bodyLower = (message.body || '').trim().toLowerCase();
    if (!pengajuanBySender[chatId] || bodyLower === 'menu') {
      if (helpdeskQueue[chatId]) {
        // jika masih ada alur helpdesk, jangan tampilkan menu
      } else {
        const menu = `Halo ${pegawai['Nama Pegawai']}! 👋\nAda yang bisa kami bantu hari ini?\n\n`+
          `Silakan pilih menu:\n`+
          `1. Pengajuan Lembur\n`+
          `2. Pengajuan Cuti\n`+
          `3. Chat Helpdesk\n\n`+
          `Ketik *angka* pilihan.`;
        await kirimDenganTyping(client, chatId, menu);
        pengajuanBySender[chatId] = { step: 'menu', pegawai };
        return;
      }
    }

    const flow = pengajuanBySender[chatId];
    if (flow && flow.step === 'menu') {
      if (bodyLower === '1') {
        await kirimDenganTyping(client, chatId, 'Silakan tuliskan *alasan/tujuan lembur* Anda.');
        pengajuanBySender[chatId] = { ...flow, step: 'alasan-lembur', jenis: 'Lembur' };
        return;
      }
      if (bodyLower === '2') {
        await kirimDenganTyping(client, chatId, 'Silakan tuliskan *alasan pengajuan cuti* Anda.');
        pengajuanBySender[chatId] = { ...flow, step: 'alasan-cuti', jenis: 'Cuti' };
        return;
      }
      if (bodyLower === '3') {
        await kirimDenganTyping(client, chatId, 'Silakan tuliskan pertanyaan Anda untuk Helpdesk.');
        // pindah ke helpdesk mode
        helpdeskQueue[chatId] = { step: 'pertanyaan' };
        delete pengajuanBySender[chatId];
        return;
      }
      await kirimDenganTyping(client, chatId, 'Pilihan tidak valid. Ketik 1 untuk lembur, 2 untuk cuti, atau 3 untuk Helpdesk.');
      return;
    }

    if (flow && (flow.step === 'alasan-lembur' || flow.step === 'alasan-cuti')) {
      const alasan = message.body.trim();
      const atasan = cariAtasanPegawai(pegawai);
      if (!atasan) {
        await kirimDenganTyping(client, chatId, 'Maaf, data atasan Anda tidak ditemukan. Hubungi admin.');
        delete pengajuanBySender[chatId];
        return;
      }

      const jenis = flow.jenis; // 'Lembur' / 'Cuti'
      pengajuanBySender[chatId] = { ...flow, step: 'menunggu-persetujuan', alasan, atasan };

      const nomorAtasan = (atasan['No. HP (WA) aktif'] || '') + '@c.us';
      const teksAtasan =
`📢 *Pengajuan ${jenis}* dari ${pegawai['Nama Pegawai']}\n`+
`Alasan: ${alasan}\n\n`+
`*Balas pesan ini (QUOTE REPLY) dengan angka:*\n`+
`1. Setuju ✅\n2. Tidak Setuju ❌`;

      // kirim ke atasan dan simpan id pesan untuk approval via quote
      const sentToAtasan = await client.sendMessage(nomorAtasan, teksAtasan);
      logOut(nomorAtasan, teksAtasan);
      pengajuanByAtasanMsgId[sentToAtasan.id._serialized] = {
        sender: chatId,
        jenis,
        pegawai,
        atasan
      };

      await kirimDenganTyping(client, chatId, `Pengajuan ${jenis} Anda sudah diteruskan ke atasan untuk persetujuan.`);
      return;
    }

    // Jika internal tapi tidak cocok flow apapun
    // Cek jika user sudah pindah ke helpdesk mode, jangan kirim fallback
    if (helpdeskQueue[chatId]) return;
    await kirimDenganTyping(client, chatId, 'Perintah tidak dikenali. Ketik *menu* untuk kembali ke menu utama.');
  } catch (err) {
    console.error('[ERROR] Terjadi kesalahan saat memproses pesan:', err);
    try {
      await kirimDenganTyping(client, message.from, 'Maaf, terjadi kesalahan pada sistem. Silakan coba lagi nanti.');
    } catch {}
  }
});

// ====== GLOBAL ERROR HANDLERS ======
process.on('unhandledRejection', (reason, p) => {
  console.error('[UNHANDLED REJECTION]', reason);
  logToFile('error', 'UNHANDLED', String(reason));
});

process.on('uncaughtException', err => {
  console.error('[UNCAUGHT EXCEPTION]', err);
  logToFile('error', 'UNCAUGHT', err.stack || String(err));
  process.exit(1); // hard fail, biar ketahuan
});

// ====== START ======
client.initialize();
