# GetContact Telegram Bot (Node.js + SQLite)

Versi ini berjalan di komputer sendiri melalui polling Telegram. **Tidak perlu webhook, domain, HTTPS publik, PHP, MySQL, atau file `.env`.**

## Persyaratan
- Node.js **22.5 atau lebih baru** (disarankan Node.js 22 LTS atau 24 LTS).
- Internet.
- Token bot dari BotFather.
- Credential GetContact milik Anda.

SQLite memakai modul bawaan `node:sqlite`, jadi tidak perlu memasang database/server terpisah.

## Menjalankan di VS Code (Windows)
1. Ekstrak ZIP.
2. Buka folder `getcontact-telegram-node` di VS Code.
3. Buka Terminal -> New Terminal.
4. Pastikan Node tersedia:
   ```bash
   node -v
   ```
   Versi harus minimal `v22.5.0`.
5. Install dependency:
   ```bash
   npm install
   ```
6. Salin `config.example.json` menjadi `config.json`.
   PowerShell:
   ```powershell
   Copy-Item config.example.json config.json
   ```
   CMD:
   ```cmd
   copy config.example.json config.json
   ```
7. Edit `config.json`:
   - `botToken`: token dari BotFather.
   - `adminIds`: Telegram numeric ID Anda.
   - `getcontact.hmacSecretKey`: HMAC secret sesuai konfigurasi sumber.
   - `getcontact.credentials`: masukkan Final Key dan Token sendiri, atau tambahkan dari Admin Panel setelah bot berjalan.
8. Jalankan:
   ```bash
   npm start
   ```
9. Buka bot Telegram dan kirim `/start`.
10. Untuk berhenti, tekan `Ctrl+C` pada terminal.

## Cara menggunakan
- `/start` membuka menu.
- Cari Tag -> kirim nomor. Bot menjalankan endpoint pencarian GetContact; data yang ditampilkan mengikuti respons API. Daftar tag hanya dapat ditampilkan jika endpoint benar-benar mengembalikannya.
- Lihat Profil -> kirim nomor. Bot menampilkan ringkasan profil (nama tampilan, nomor, negara, jumlah tag, badge/spam jika tersedia), bukan JSON mentah.
- Kuota Saya -> melihat sisa kuota.
- Panduan -> cara menggunakan bot dan format nomor.
- Tentang Bot -> ringkasan fitur, teknologi, dan batasan.
- Admin: `/admin`.
- Tambah credential dari Admin Panel: kirim empat baris opsional:
  `Nama akun`, `Final Key`, `Token`, `Device ID`.
- Tambah langganan dari Admin Panel: `TELEGRAM_ID HARI KUOTA_HARIAN`.
- Nonaktifkan credential: `/delcred ID`.
- Batalkan input: `/cancel`.

## Tampilan menu
Tombol inline memperbarui pesan menu yang sama (edit message), bukan mengirim pesan menu baru setiap kali ditekan. Menu mempertahankan Cari Tag dan Lihat Profil sebagai dua alur terpisah. Setelah memilih layanan, pesan tersebut berubah menjadi instruksi, status proses, lalu hasil.

## Database
Bot otomatis membuat `data/bot.sqlite`. File ini menyimpan pengguna, langganan, kuota, log, dan credential. Jangan bagikan file database atau `config.json`.

## Catatan fungsi
Versi ini mengubah bot ke Node.js dan memindahkan operasi pencarian tag serta detail nomor ke proses Telegram. Generator credential otomatis, pendaftaran akun, alur VerifyKit, dan antarmuka CAPTCHA dari aplikasi web belum disertakan. Jika API meminta CAPTCHA, bot memberi pesan agar credential diverifikasi melalui aplikasi resmi; bot tidak mencoba melewati CAPTCHA.

## Troubleshooting
- `node is not recognized`: install Node.js LTS lalu restart VS Code.
- `Cannot find module`: jalankan `npm install` di folder proyek.
- `node:sqlite` tidak ditemukan: Node.js terlalu lama; upgrade minimal 22.5.
- `ETELEGRAM: 401 Unauthorized`: token BotFather salah.
- `409 Conflict`: bot yang sama sedang berjalan di proses/komputer lain. Hentikan proses bot lain.
- `API menolak permintaan`: periksa Final Key, Token, Device ID, versi aplikasi dan konfigurasi API.

## Pemetaan fitur GetContact
- **Cari Tag** menggunakan endpoint `/v2.8/number-detail` dengan `source: profile` (sesuai fungsi `getcontact_call_api_number_detail` pada web sumber). Daftar ditampilkan dari `result.tags` bila API mengembalikannya.
- **Lihat Profil** menggunakan endpoint `/v2.8/search` dengan `source: search` (sesuai fungsi `getcontact_call_api_search` pada web sumber). Foto profil dikirim sebagai foto Telegram jika `result.profile.profileImage` berisi URL HTTPS yang dapat diakses Telegram.
- Jika API tidak mengembalikan daftar tag atau foto, bot menyampaikan keterbatasan itu; bot tidak membuat data sendiri.
