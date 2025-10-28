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

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const PDFDocument = require('pdfkit');
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

function calculateDuration(startStr, endStr) {
  if (!startStr || !endStr || !startStr.includes(':') || !endStr.includes(':')) return 'N/A';
  try {
    const [startH, startM] = startStr.split(':').map(Number);
    const [endH, endM] = endStr.split(':').map(Number);

    const startDate = new Date(0, 0, 0, startH, startM, 0);
    let endDate = new Date(0, 0, 0, endH, endM, 0);

    // Handle overnight case
    if (endDate < startDate) {
      endDate.setDate(endDate.getDate() + 1);
    }

    const diffMs = endDate - startDate;
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffMins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));

    return `${diffHours} jam ${diffMins} menit`;
  } catch (e) {
    console.error("Error calculating duration:", e);
    return 'Error';
  }
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

async function buatLaporanLemburDenganFoto(data, fotoPaths, chatId, client) {
  return new Promise((resolve, reject) => {
    const filePath = path.join(__dirname, 'reports', `Laporan_Lembur_${data.nama}_${data.tanggal}.pdf`);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const doc = new PDFDocument();
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    doc.fontSize(14).text('KEMENTERIAN KETENAGAKERJAAN RI', { align: 'center' });
    doc.text('SEKRETARIAT JENDERAL - BIRO KEUANGAN DAN BMN', { align: 'center' });
    doc.moveDown();
    doc.fontSize(12).text(
  'Jl. Gatot Subroto No.Kav 51, RT.5/RW.4, Kuningan Tim., Kecamatan Setiabudi, Kota Jakarta Selatan, DKI Jakarta 12950 (Lantai 3A)',
  { align: 'center' }

  doc.moveDown(0.5);
const pageWidth = doc.page.width;      
const margin = 50;                     
doc.moveTo(margin, doc.y)              
   .lineTo(pageWidth - margin, doc.y)  
   .stroke();                          

  
    doc.fontSize(12).text('LAPORAN LEMBUR', { align: 'center' });
    doc.moveDown();

    doc.text(`Nama : ${data.nama}`);
doc.text(`NIP : ${data.nip}`);
doc.text(`Tanggal : ${data.tanggal}`);
doc.text(`Nama Atasan : ${data.namaAtasan}`);
doc.text(`Jabatan Atasan : ${data.jabatanAtasan}`);
doc.text(`Jam Mulai : ${data.jamMasuk || 'N/A'}`);
doc.text(`Jam Selesai : ${data.jamKeluar || 'N/A'}`);
doc.text(`Total Jam Lembur : ${calculateDuration(data.jamMasuk, data.jamKeluar)}`);
doc.text(`Uraian Kegiatan : ${data.kegiatan}`);
    doc.moveDown();
// test
    const addImage = (label, imagePath) => {
      if (imagePath && fs.existsSync(imagePath)) {
        doc.text(label, { underline: true });
        doc.image(imagePath, { fit: [400, 250], align: 'center' });
        doc.moveDown();
      }
    };

    addImage('Foto Hasil Lembur:', fotoPaths[0]);
    addImage('Foto Pegawai di Tempat Lembur:', fotoPaths[1]);
    addImage('Screenshot Approval:', fotoPaths[2]);

    doc.text('Mengetahui,');
    doc.text('Kepala Sub Bagian TU Biro Keuangan dan BMN');
    doc.moveDown(3);
    doc.text('ALPHA SANDRO ADITTHYASWARA, S.Sos');
    doc.text('NIP. 198703232015031002');

    doc.end();

    stream.on('finish', async () => {
      try {
        console.log(`[PDF] Berhasil dibuat: ${filePath}`);
        const media = MessageMedia.fromFilePath(filePath);
        await client.sendMessage(chatId, media, { caption: "Berikut laporan lembur final Anda 📑✅" });
        if (data.nomorAtasan) {
          await client.sendMessage(data.nomorAtasan, media, { caption: `Laporan lembur ${data.nama} sudah dibuat.` });
        }
        resolve();
      } catch (err) {
        console.error('[PDF] Gagal mengirim PDF:', err);
        reject(err);
      }
    });

    stream.on('error', reject);
  });
}

// ====== INIT CLIENT ======
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-extensions',
      '--disable-gpu',
    ],
  },
});

client.on('qr', qr => {
  qrcode.generate(qr, { small: true });
  console.log('[QR] Tersedia. Scan ya brad.');
});

client.on('ready', () => console.log('✅ [READY] Bot SisKA siap Broer! 🚀'));

client.on('authenticated', () => {
  console.log('[WA] Authenticated!');
});

client.on('auth_failure', msg => {
  console.error('[WA] Auth failure:', msg);
});

client.on('message_create', (msg) => {
  console.log('[DEBUG] message_create:', msg.from, '| Body:', msg.body);
});
client.on('disconnected', reason => console.log(`[WA] Bot disconnect: ${reason}`));

// ====== MESSAGE HANDLER ======
client.on('message', async (message) => {
  console.log('[DEBUG] Pesan diterima:', message.from, '| Body:', message.body, '| hasMedia:', message.hasMedia);
  try {
    const chatId = message.from; // bisa @c.us atau @g.us
    const isGroup = chatId.endsWith('@g.us');
    const digits = hanyaAngka(chatId);
    const pegawai = cariPegawaiByWa(digits);

    const flow = pengajuanBySender[chatId];
    logIn(chatId, message.body);

    // Handle upload foto dokumentasi lembur
    if (flow?.step === 'upload-foto') {
      if (message.hasMedia) {
          console.log('[DEBUG] Proses upload foto lembur untuk', chatId, '| Foto ke-', (flow.fotoList?.length || 0) + 1);
          const media = await message.downloadMedia();
          const fotoDir = path.join(__dirname, 'uploads');
          fs.mkdirSync(fotoDir, { recursive: true });
          const fotoPath = path.join(fotoDir, `foto_${chatId}_${Date.now()}.jpg`);
          fs.writeFileSync(fotoPath, media.data, 'base64');

          if (!flow.fotoList) flow.fotoList = [];
          flow.fotoList.push(fotoPath);

          if (flow.fotoList.length < 3) {
            await kirimDenganTyping(client, chatId, `Foto ${flow.fotoList.length} sudah diterima ✅. Silakan upload foto ke-${flow.fotoList.length + 1}.`);
            console.log('[DEBUG] State upload-foto:', { chatId, fotoList: flow.fotoList });
          } else {
            await kirimDenganTyping(client, chatId, 'Semua foto sudah diterima, sedang membuat laporan PDF...');
            const data = {
              nama: flow.pegawai['Nama Pegawai'],
              nip: flow.pegawai['NIP'] || '',
              tanggal: new Date().toISOString().split('T')[0],
              kegiatan: flow.alasan || '',
              nomorAtasan: flow.atasan ? (flow.atasan['No. HP (WA) aktif'] + '@c.us') : null,
              jamMasuk: flow.jamMasuk,
              jamKeluar: flow.jamKeluar
            };
            await buatLaporanLemburDenganFoto(data, flow.fotoList, chatId, client);
            delete pengajuanBySender[chatId];
            console.log('[DEBUG] State upload-foto selesai dan dihapus:', chatId);
          }
      } else {
        // Mengabaikan pesan teks/kosong yang mungkin merupakan event duplikat saat upload media
        console.log('[DEBUG] Pesan teks/kosong diterima saat step upload-foto, diabaikan.');
      }
      // Keluar dari handler setelah memproses langkah upload foto
      return;
    }

    // ----- 0) Handler dari grup (helpdesk & approval via quote) -----
    if (isGroup) {
      console.log('[DEBUG] Pesan dari grup', chatId);
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
      console.log('[DEBUG] Pesan dengan quotedMsg dari', chatId);
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
              pesanPegawai += `\n\nMohon upload *3 foto* dokumentasi lembur Anda sebagai bukti:\n1. Foto hasil lembur\n2. Foto Anda di tempat lembur\n3. Screenshot approval dari atasan.`;
              // simpan state upload foto & info pegawai, alasan, atasan
              pengajuanBySender[pemohonId] = {
                step: 'upload-foto',
                pegawai: pengajuan.pegawai,
                alasan: pengajuan.alasan,
                atasan: pengajuan.atasan,
                jamMasuk: pengajuan.jamMasuk,
                jamKeluar: pengajuan.jamKeluar
              };
              console.log('[DEBUG] Set upload-foto state untuk', pemohonId, pengajuanBySender[pemohonId]);
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

    // ========== EKSTERNAL ==========
    if (!pegawai || helpdeskQueue[chatId]) {
      console.log('[DEBUG] Flow eksternal untuk', chatId);
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
    console.log('[DEBUG] Flow internal untuk', chatId, '| Step:', pengajuanBySender[chatId]?.step);
    const bodyLower = (message.body || '').trim().toLowerCase();
    if (!pengajuanBySender[chatId] || bodyLower === 'menu') {
      if (helpdeskQueue[chatId]) {
        // jika masih ada alur helpdesk, jangan tampilkan menu
      } else {
        console.log('[DEBUG] User masuk menu utama');
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

    if (flow && flow.step === 'menu') {
      if (bodyLower === '1') {
        console.log('[DEBUG] User pilih menu lembur');
        await kirimDenganTyping(client, chatId, 'Silakan tuliskan *alasan/tujuan lembur* Anda.');
        pengajuanBySender[chatId] = { ...flow, step: 'alasan-lembur', jenis: 'Lembur' };
        return;
      }
      if (bodyLower === '2') {
        console.log('[DEBUG] User pilih menu cuti');
        await kirimDenganTyping(client, chatId, 'Silakan tuliskan *alasan pengajuan cuti* Anda.');
        pengajuanBySender[chatId] = { ...flow, step: 'alasan-cuti', jenis: 'Cuti' };
        return;
      }
      if (bodyLower === '3') {
        console.log('[DEBUG] User pilih menu helpdesk');
        await kirimDenganTyping(client, chatId, 'Silakan tuliskan pertanyaan Anda untuk Helpdesk.');
        // pindah ke helpdesk mode
        helpdeskQueue[chatId] = { step: 'pertanyaan' };
        delete pengajuanBySender[chatId];
        return;
      }
      await kirimDenganTyping(client, chatId, 'Pilihan tidak valid. Ketik 1 untuk lembur, 2 untuk cuti, atau 3 untuk Helpdesk.');
      return;
    }

    if (flow && flow.step === 'alasan-cuti') {
      const alasan = message.body.trim();
      console.log('[DEBUG] Terima alasan cuti', alasan);
      const atasan = cariAtasanPegawai(flow.pegawai);
      if (!atasan) {
        await kirimDenganTyping(client, chatId, 'Maaf, data atasan Anda tidak ditemukan. Hubungi admin.');
        delete pengajuanBySender[chatId];
        return;
      }
      pengajuanBySender[chatId] = { ...flow, step: 'menunggu-persetujuan', alasan, atasan };

      const nomorAtasan = (atasan['No. HP (WA) aktif'] || '') + '@c.us';
      const teksAtasan =
`📢 *Pengajuan Cuti* dari ${flow.pegawai['Nama Pegawai']}\n`+
`Alasan: ${alasan}\n\n`+
`*Balas pesan ini (QUOTE REPLY) dengan angka:*\n`+
`1. Setuju ✅\n2. Tidak Setuju ❌`;

      const sentToAtasan = await client.sendMessage(nomorAtasan, teksAtasan);
      logOut(nomorAtasan, teksAtasan);
      pengajuanByAtasanMsgId[sentToAtasan.id._serialized] = {
        sender: chatId,
        jenis: flow.jenis,
        pegawai: flow.pegawai,
        atasan,
        alasan
      };
      await kirimDenganTyping(client, chatId, `Pengajuan Cuti Anda sudah diteruskan ke atasan untuk persetujuan.`);
      return;
    }

    if (flow && flow.step === 'alasan-lembur') {
      const alasan = message.body.trim();
      console.log('[DEBUG] Terima alasan lembur:', alasan);
      pengajuanBySender[chatId].alasan = alasan;
      pengajuanBySender[chatId].step = 'tanya-jam-masuk';
      await kirimDenganTyping(client, chatId, 'Baik, sekarang masukkan *jam mulai lembur* Anda (format 24 jam, contoh: 17:00).');
      return;
    }

    if (flow && flow.step === 'tanya-jam-masuk') {
      const jamMasuk = message.body.trim();
      console.log('[DEBUG] Terima jam masuk:', jamMasuk);
      pengajuanBySender[chatId].jamMasuk = jamMasuk;
      pengajuanBySender[chatId].step = 'tanya-jam-keluar';
      await kirimDenganTyping(client, chatId, 'Oke, terakhir masukkan *jam selesai lembur* Anda (format 24 jam, contoh: 20:00).');
      return;
    }

    if (flow && flow.step === 'tanya-jam-keluar') {
      const jamKeluar = message.body.trim();
      console.log('[DEBUG] Terima jam keluar:', jamKeluar);
      pengajuanBySender[chatId].jamKeluar = jamKeluar;

      const atasan = cariAtasanPegawai(flow.pegawai);
      if (!atasan) {
        await kirimDenganTyping(client, chatId, 'Maaf, data atasan Anda tidak ditemukan. Hubungi admin.');
        delete pengajuanBySender[chatId];
        return;
      }

      const { alasan, jamMasuk } = flow;
      pengajuanBySender[chatId] = { ...flow, step: 'menunggu-persetujuan', atasan };

      const nomorAtasan = (atasan['No. HP (WA) aktif'] || '') + '@c.us';
      const teksAtasan =
`📢 *Pengajuan Lembur* dari ${flow.pegawai['Nama Pegawai']}\n`+
`Alasan: ${alasan}\n`+
`Jam: ${jamMasuk} - ${jamKeluar}\n\n`+
`*Balas pesan ini (QUOTE REPLY) dengan angka:*\n`+
`1. Setuju ✅\n2. Tidak Setuju ❌`;

      const sentToAtasan = await client.sendMessage(nomorAtasan, teksAtasan);
      logOut(nomorAtasan, teksAtasan);
      pengajuanByAtasanMsgId[sentToAtasan.id._serialized] = {
        sender: chatId,
        jenis: flow.jenis,
        pegawai: flow.pegawai,
        atasan,
        alasan,
        jamMasuk,
        jamKeluar
      };

      await kirimDenganTyping(client, chatId, `Pengajuan Lembur Anda sudah diteruskan ke atasan untuk persetujuan.`);
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
