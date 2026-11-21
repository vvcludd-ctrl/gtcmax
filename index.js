const fs = require('node:fs');
const path = require('node:path');
const TelegramBot = require('node-telegram-bot-api');
const { DatabaseSync } = require('node:sqlite');
const { requestGetContact } = require('./src/getcontact');

const configPath = path.join(__dirname, 'config.json');
if (!fs.existsSync(configPath)) {
  console.error('config.json belum ada. Salin config.example.json menjadi config.json lalu isi token bot.');
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
if (!config.botToken || config.botToken.startsWith('ISI_')) {
  console.error('Isi botToken di config.json terlebih dahulu.'); process.exit(1);
}
const dbDir = path.join(__dirname, 'data');
fs.mkdirSync(dbDir, {recursive:true});
const db = new DatabaseSync(path.join(dbDir, 'bot.sqlite'));
db.exec(`
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS users (
 telegram_id INTEGER PRIMARY KEY, username TEXT, first_name TEXT,
 created_at TEXT DEFAULT CURRENT_TIMESTAMP, last_seen TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS subscriptions (
 id INTEGER PRIMARY KEY AUTOINCREMENT, telegram_id INTEGER NOT NULL,
 starts_at TEXT NOT NULL, expires_at TEXT NOT NULL, quota_daily INTEGER NOT NULL,
 active INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_sub_user ON subscriptions(telegram_id,active,expires_at);
CREATE TABLE IF NOT EXISTS usage_daily (
 telegram_id INTEGER NOT NULL, usage_date TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(telegram_id,usage_date)
);
CREATE TABLE IF NOT EXISTS credentials (
 id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, final_key TEXT NOT NULL,
 token TEXT NOT NULL, device_id TEXT DEFAULT '', active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS logs (
 id INTEGER PRIMARY KEY AUTOINCREMENT, telegram_id INTEGER, action TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS states (
 telegram_id INTEGER PRIMARY KEY, state TEXT NOT NULL
);
`);
const bot = new TelegramBot(config.botToken, {polling:{autoStart:true, params:{timeout:30}}});
const screenMessages = new Map();
async function showScreen(chatId, userId, text, options={}) {
 if (!options.reply_markup) options.reply_markup = {inline_keyboard:[[{text:'🏠 Menu Utama',callback_data:'home'}]]};
 const messageId = screenMessages.get(Number(userId));
 if (messageId) {
  try { return await bot.editMessageText(text, {chat_id:chatId, message_id:messageId, ...options}); }
  catch (e) {
   if (/message is not modified/i.test(e.message)) {
    // Telegram menolak edit identik; kirim menu baru agar /start tetap memberi respons.
    const sent = await bot.sendMessage(chatId, text, options);
    screenMessages.set(Number(userId), sent.message_id);
    return sent;
   }
   console.warn('Edit message; mengganti pesan lama:', e.message);
   try { await bot.deleteMessage(chatId,messageId); } catch {}
   screenMessages.delete(Number(userId));
  }
 }
 const sent = await bot.sendMessage(chatId, text, options);
 screenMessages.set(Number(userId), sent.message_id);
 return sent;
}
const admins = (config.adminIds || []).map(Number);
const isAdmin = id => admins.includes(Number(id));
const today = () => new Intl.DateTimeFormat('en-CA', {timeZone:config.timezone || 'Asia/Jakarta'}).format(new Date());
const stmt = sql => db.prepare(sql);
function log(id, action) { stmt('INSERT INTO logs(telegram_id,action) VALUES(?,?)').run(id,action); }
function setState(id,state) { stmt('INSERT INTO states(telegram_id,state) VALUES(?,?) ON CONFLICT(telegram_id) DO UPDATE SET state=excluded.state').run(id,state); }
function getState(id) { return stmt('SELECT state FROM states WHERE telegram_id=?').get(id)?.state || null; }
function clearState(id) { stmt('DELETE FROM states WHERE telegram_id=?').run(id); }
function upsertUser(u) {
 stmt(`INSERT INTO users(telegram_id,username,first_name) VALUES(?,?,?)
 ON CONFLICT(telegram_id) DO UPDATE SET username=excluded.username,first_name=excluded.first_name,last_seen=CURRENT_TIMESTAMP`)
 .run(u.id,u.username || null,u.first_name || null);
}
function quota(id) {
 if (isAdmin(id)) return {ok:true,left:'∞',limit:'∞',expires:'Admin'};
 const s=stmt(`SELECT * FROM subscriptions WHERE telegram_id=? AND active=1
 AND starts_at<=datetime('now','localtime') AND expires_at>datetime('now','localtime')
 ORDER BY expires_at DESC LIMIT 1`).get(id);
 if(!s) return {ok:false,left:0,limit:0};
 const used=stmt('SELECT used FROM usage_daily WHERE telegram_id=? AND usage_date=?').get(id,today())?.used || 0;
 return {ok:used<s.quota_daily,left:Math.max(0,s.quota_daily-used),limit:s.quota_daily,expires:s.expires_at};
}
function consume(id) {
 stmt(`INSERT INTO usage_daily(telegram_id,usage_date,used) VALUES(?,?,1)
 ON CONFLICT(telegram_id,usage_date) DO UPDATE SET used=used+1`).run(id,today());
}
async function menu(id) {
 const inline_keyboard=[
  [{text:'🔎 Cari Tag',callback_data:'search'},{text:'👤 Lihat Profil',callback_data:'profile'}],
  [{text:'📊 Kuota Saya',callback_data:'quota'},{text:'📖 Panduan',callback_data:'help'}],
  [{text:'✨ Tentang Bot',callback_data:'about'}]
 ];
 if(isAdmin(id)) inline_keyboard.push([{text:'🛠 Admin Panel',callback_data:'admin'}]);
 return showScreen(id,id,'<b>📱 GETCONTACT BOT</b>\n<i>Pencarian identitas nomor dan ringkasan profil melalui layanan GetContact.</i>\n\nPilih fitur yang ingin digunakan di bawah ini.\n\n<tg-spoiler>Gunakan layanan secara bijak dan hormati privasi orang lain.</tg-spoiler>',{parse_mode:'HTML',reply_markup:{inline_keyboard}});
}
function adminPanel(id) {
 const users=stmt('SELECT COUNT(*) n FROM users').get().n;
 const searches=stmt("SELECT COUNT(*) n FROM logs WHERE date(created_at)=date('now','localtime') AND action IN ('search','profile')").get().n;
 const creds=stmt('SELECT COUNT(*) n FROM credentials WHERE active=1').get().n;
 return showScreen(id,id,`<b>Admin Panel</b>\nPengguna: ${users}\nPencarian hari ini: ${searches}\nCredential aktif: ${creds}`,{
  parse_mode:'HTML',reply_markup:{inline_keyboard:[
   [{text:'➕ Tambah Credential',callback_data:'cred_add'}],
   [{text:'📋 Daftar Credential',callback_data:'cred_list'}],
   [{text:'➕ Beri Langganan',callback_data:'sub_add'}],
   [{text:'👥 Pengguna',callback_data:'users'},{text:'📈 Statistik',callback_data:'stats'}],
   [{text:'🔙 Menu',callback_data:'home'}]
  ]}
 });
}
function getApiRoot(result) {
 return result?.result || result?.data?.result || result;
}
function getProfile(result) {
 const root=getApiRoot(result);
 return root?.profile || root?.numberDetail?.profile || root?.data?.profile || {};
}
function profileText(result, number, left) {
 const root=getApiRoot(result), p=getProfile(result);
 const val=v=>(v===null||v===undefined||v===''?'-':String(v));
 const fields=[
  ['Nama',p.displayName || [p.name,p.surname].filter(Boolean).join(' ')],
  ['Nomor',p.displayNumber || p.phoneNumber || number],
  ['Negara',p.country || p.countryCode],
  ['Jumlah tag',p.tagCount],
  ['Email',p.email],
  ['Badge',root?.badge],
  ['Kategori spam',root?.spamInfo?.degree && root.spamInfo.degree!=='none'?root.spamInfo.degree:null],
  ['Tipe akun',root?.premiumType]
 ];
 const lines=fields.filter(([,v])=>v!==null&&v!==undefined&&v!=='').map(([k,v])=>`<b>${k}:</b> ${escapeHtml(val(v))}`);
 if(!lines.length) lines.push('<i>API merespons, tetapi detail profil tidak tersedia.</i>');
 lines.push('',`<b>Sisa kuota hari ini:</b> ${escapeHtml(left)}`);
 return `<b>👤 Profil GetContact</b>\n<i>Informasi profil nomor</i>\n\n${lines.join('\n')}\n\n<i>Data mengikuti ketersediaan API GetContact.</i>`;
}
function tagText(result, number, left) {
 const root=getApiRoot(result);
 const tags=Array.isArray(root?.tags)?root.tags:(Array.isArray(root?.numberDetail?.tags)?root.numberDetail.tags:[]);
 const p=root?.profile || {};
 const lines=[`<b>🔎 Hasil Pencarian Tag</b>`,`<i>Daftar tag yang dikembalikan server</i>`,``,`<b>Nomor:</b> ${escapeHtml(p.displayNumber || p.phoneNumber || number)}`,''];
 if(tags.length){
  lines.push(`<b>Total tag ditemukan: ${tags.length}</b>`,'');
  tags.slice(0,60).forEach((item,i)=>{
   const tag=typeof item==='string'?item:(item?.tag ?? item?.name ?? '');
   const count=typeof item==='object'?(item?.count ?? null):null;
   if(tag) lines.push(`${i+1}. ${escapeHtml(tag)}${count!==null?` — <b>${escapeHtml(count)}</b>`:''}`);
  });
  if(tags.length>60) lines.push('',`<i>Menampilkan 60 dari ${tags.length} tag.</i>`);
 } else {
  lines.push('<i>Server tidak mengembalikan daftar tag untuk nomor ini.</i>');
  if(p.tagCount!==undefined) lines.push(`<b>Jumlah tag pada profil:</b> ${escapeHtml(p.tagCount)}`);
 }
 lines.push('',`<b>Sisa kuota hari ini:</b> ${escapeHtml(left)}`,'', '<i>Daftar tag hanya ditampilkan jika tersedia dari API GetContact.</i>');
 return lines.join('\n');
}
async function showProfileResult(chatId,userId,result,number,left) {
 const text=profileText(result,number,left), p=getProfile(result), photo=p.profileImage;
 const messageId=screenMessages.get(Number(userId));
 const keyboard={inline_keyboard:[[{text:'👤 Cek Profil Lain',callback_data:'profile'}],[{text:'🏠 Menu Utama',callback_data:'home'}]]};
 if(messageId){try{await bot.deleteMessage(chatId,messageId);}catch{}}
 screenMessages.delete(Number(userId));
 if(typeof photo==='string' && /^https:\/\//i.test(photo)){
  try {
   const sent=await bot.sendPhoto(chatId,photo,{caption:text,parse_mode:'HTML',reply_markup:keyboard});
   screenMessages.set(Number(userId),sent.message_id); return sent;
  } catch(e){console.warn('Foto profil tidak dapat dikirim:',e.message);}
 }
 const sent=await bot.sendMessage(chatId,text,{parse_mode:'HTML',reply_markup:keyboard});
 screenMessages.set(Number(userId),sent.message_id); return sent;
}
async function runLookup(chatId,userId,phone,type) {
 const number=phone.replace(/[\s\-()]/g,'');
 if(!/^\+?[0-9]{7,15}$/.test(number)) return showScreen(chatId,userId,'Nomor tidak valid. Contoh: <code>+628123456789</code>',{parse_mode:'HTML',reply_markup:{inline_keyboard:[[{text:'⬅️ Menu',callback_data:'home'}]]}});
 const q=quota(userId);
 if(!q.ok) return showScreen(chatId,userId,'Langganan tidak aktif atau kuota harian habis. Hubungi admin.',{reply_markup:{inline_keyboard:[[{text:'⬅️ Menu',callback_data:'home'}]]}});
 const credentials=stmt('SELECT * FROM credentials WHERE active=1').all();
 if(!credentials.length) return showScreen(chatId,userId,'Credential belum tersedia. Admin perlu menambahkan credential.',{reply_markup:{inline_keyboard:[[{text:'⬅️ Menu',callback_data:'home'}]]}});
 const cred=credentials[Math.floor(Math.random()*credentials.length)];
 await showScreen(chatId,userId,type==='search'?'⏳ Sedang mencari informasi nomor di GetContact...':'⏳ Sedang mengambil detail profil GetContact...');
 try {
  const result=await requestGetContact({config:config.getcontact,credential:{finalKey:cred.final_key,token:cred.token,deviceId:cred.device_id},phone:number.replace(/^\+/,''),type});
  if(!isAdmin(userId)) consume(userId);
  log(userId,type);
  const after=quota(userId);
  if(type==='profile') return showProfileResult(chatId,userId,result,number,after.left);
  return showScreen(chatId,userId,tagText(result,number,after.left),{parse_mode:'HTML',reply_markup:{inline_keyboard:[[{text:'🔎 Cari Nomor Lain',callback_data:'search'}],[{text:'🏠 Menu Utama',callback_data:'home'}]]}});
 } catch(e) {
  console.error('GetContact request:',e.message);
  return showScreen(chatId,userId,`<b>Permintaan GetContact gagal</b>\n${escapeHtml(e.message)}`,{parse_mode:'HTML',reply_markup:{inline_keyboard:[[{text:'🔁 Coba Lagi',callback_data:type}],[{text:'🏠 Menu Utama',callback_data:'home'}]]}});
 }
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

bot.on('polling_error', e => console.error('Telegram polling error:',e.message));
bot.on('message', async msg => {
 const id=msg.from?.id, chat=msg.chat.id, text=(msg.text||'').trim();
 if(!id || msg.chat.type!=='private') return;
 upsertUser(msg.from);
 try {
  if(/^\/(start|menu)(?:@[^\s]+)?(?:\s|$)/i.test(text)) { clearState(id); return await menu(chat); }
  if(text==='/cancel') { clearState(id); return await menu(chat); }
  if(text==='/admin') return isAdmin(id)?adminPanel(chat):undefined;
  if(text.startsWith('/delcred')) {
   if(!isAdmin(id)) return;
   const m=text.match(/^\/delcred\s+(\d+)$/);
   if(!m) return bot.sendMessage(chat,'Gunakan /delcred ID');
   const r=stmt('UPDATE credentials SET active=0 WHERE id=?').run(Number(m[1]));
   return bot.sendMessage(chat,r.changes?'Credential dinonaktifkan.':'ID tidak ditemukan.');
  }
  const state=getState(id);
  if(state==='cred_add' && isAdmin(id)) {
   const p=text.split(/\r?\n/);
   if(p.length<3||!p[1]||!p[2]) return showScreen(chat,id,'Format salah. Kirim 3 baris: Nama akun, Final Key, Token. Baris ke-4 Device ID opsional. /cancel untuk batal.');
   if(p[1].trim().length<16||p[2].trim().length<8) return showScreen(chat,id,'Final Key atau Token terlalu pendek.');
   stmt('INSERT INTO credentials(name,final_key,token,device_id) VALUES(?,?,?,?)').run(p[0].trim(),p[1].trim(),p[2].trim(),(p[3]||'').trim());
   clearState(id); log(id,'credential_added'); return showScreen(chat,id,'Credential disimpan di SQLite.');
  }
  if(state==='sub_add' && isAdmin(id)) {
   const m=text.match(/^(\d+)\s+(\d{1,4})\s+(\d{1,5})$/);
   if(!m) return showScreen(chat,id,'Format: TELEGRAM_ID HARI KUOTA_HARIAN. Contoh: 123456789 30 20. /cancel untuk batal.');
   const [uid,days,limit]=m.slice(1).map(Number);
   if(days<1||days>3650||limit<1||limit>100000) return showScreen(chat,id,'Nilai hari atau kuota tidak valid.');
   stmt("INSERT INTO subscriptions(telegram_id,starts_at,expires_at,quota_daily) VALUES(?,datetime('now','localtime'),datetime('now','localtime',?),?)").run(uid,`+${days} days`,limit);
   clearState(id); log(id,'subscription_added'); return showScreen(chat,id,'Langganan berhasil dibuat.');
  }
  if(state==='search'||state==='profile') { const mode=state; clearState(id); return runLookup(chat,id,text,mode); }
  return menu(chat);
 } catch(e) { console.error(e); bot.sendMessage(chat,'Terjadi kesalahan internal. Periksa terminal VS Code.'); }
});
bot.on('callback_query', async q => {
 const id=q.from.id, chat=q.message.chat.id, data=q.data;
 await bot.answerCallbackQuery(q.id);
 screenMessages.set(Number(id), q.message.message_id);
 try {
  if(data==='home') { clearState(id); return menu(chat); }
  if(data==='search'||data==='profile') { setState(id,data); const prompt=data==='search'?'Kirim nomor untuk mencari informasi tag yang tersedia dari API GetContact.':'Kirim nomor untuk mengambil detail profil GetContact.'; return showScreen(chat,id,`<b>${data==='search'?'🔎 Cari Tag':'👤 Lihat Profil'}</b>\n\n${prompt}\n\n<i>Contoh: +628123456789</i>`,{parse_mode:'HTML',reply_markup:{inline_keyboard:[[{text:'❌ Batal',callback_data:'home'}]]}}); }
  if(data==='quota') { const v=quota(id); return showScreen(chat,id,v.ok?`Sisa kuota: ${v.left}/${v.limit}\nBerlaku sampai: ${v.expires}`:'Langganan tidak aktif atau kuota habis.'); }
  if(data==='help') return showScreen(chat,id,'<b>📖 PANDUAN PENGGUNAAN</b>\n\n<b>1.</b> Pilih <b>Cari Tag</b> untuk meminta hasil pencarian dari endpoint pencarian GetContact.\n<b>2.</b> Pilih <b>Lihat Profil</b> untuk meminta detail profil nomor.\n<b>3.</b> Kirim nomor dengan kode negara, misalnya <code>+628123456789</code>.\n<b>4.</b> Tunggu bot mengambil data dan menampilkan ringkasan.\n\n<b>Perintah:</b>\n/start atau /menu — menu utama\n/cancel — batalkan proses input\nGunakan tombol Kuota Saya untuk melihat sisa kuota\n\n<i>Jika pencarian tag tidak mengembalikan daftar tag, berarti endpoint/API tidak menyediakannya. Bot tidak membuat data sendiri.</i>',{parse_mode:'HTML',reply_markup:{inline_keyboard:[[{text:'🏠 Menu Utama',callback_data:'home'}]]}});
  if(data==='about') return showScreen(chat,id,'<b>✨ TENTANG GETCONTACT BOT</b>\n\nBot ini menyediakan antarmuka Telegram untuk mengakses endpoint GetContact menggunakan credential yang dikonfigurasi admin.\n\n<b>Fitur</b>\n• Cari Tag — menjalankan endpoint pencarian\n• Lihat Profil — mengambil ringkasan profil nomor\n• Kuota — melihat batas penggunaan akun\n• Admin Panel — mengelola credential, pengguna, dan langganan\n\n<b>Teknologi</b>\n• Node.js + Telegram Long Polling\n• SQLite, tanpa MySQL\n• Tidak membutuhkan webhook atau domain publik\n\n<b>Catatan</b>\nDaftar tag hanya akan tampil jika memang dikembalikan API. Kecepatan tergantung koneksi dan server GetContact. Gunakan secara bertanggung jawab dan hormati privasi.',{parse_mode:'HTML',reply_markup:{inline_keyboard:[[{text:'📖 Panduan',callback_data:'help'}],[{text:'🏠 Menu Utama',callback_data:'home'}]]}});
  if(data==='admin') return isAdmin(id)?adminPanel(chat):undefined;
  if(!isAdmin(id)) return;
  if(data==='cred_add') { setState(id,'cred_add'); return showScreen(chat,id,'Kirim 3 baris:\nNama akun\nFINAL_KEY\nTOKEN\nBaris ke-4 Device ID opsional. Gunakan chat pribadi dan /cancel untuk batal.',{reply_markup:{inline_keyboard:[[{text:'❌ Batal',callback_data:'admin'}]]}}); }
  if(data==='cred_list') {
   const rows=stmt('SELECT id,name FROM credentials WHERE active=1 ORDER BY id').all();
   return showScreen(chat,id,rows.length?'<b>Credential aktif</b>\n'+rows.map(r=>`#${r.id} — ${escapeHtml(r.name)}`).join('\n')+'\n\nHapus: /delcred ID':'Belum ada credential.',{parse_mode:'HTML'});
  }
  if(data==='sub_add') { setState(id,'sub_add'); return showScreen(chat,id,'Format: TELEGRAM_ID HARI KUOTA_HARIAN\nContoh: 123456789 30 20',{reply_markup:{inline_keyboard:[[{text:'❌ Batal',callback_data:'admin'}]]}}); }
  if(data==='users') {
   const rows=stmt('SELECT telegram_id,username FROM users ORDER BY created_at DESC LIMIT 30').all();
   return showScreen(chat,id,'<b>Pengguna terbaru</b>\n'+rows.map(r=>`<code>${r.telegram_id}</code> ${escapeHtml(r.username||'-')}`).join('\n'),{parse_mode:'HTML'});
  }
  if(data==='stats') {
   const u=stmt('SELECT COUNT(*) n FROM users').get().n;
   const s=stmt("SELECT COUNT(*) n FROM logs WHERE action IN ('search','profile')").get().n;
   return showScreen(chat,id,`Pengguna: ${u}\nTotal pencarian: ${s}`);
  }
 } catch(e) { console.error(e); bot.sendMessage(chat,'Aksi gagal. Periksa terminal VS Code.'); }
});
console.log('Bot aktif. Mode polling berjalan; tidak perlu webhook atau URL publik.');
console.log('Tekan Ctrl+C untuk menghentikan bot.');
process.on('SIGINT',()=>{bot.stopPolling();db.close();process.exit(0);});
