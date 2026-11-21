const crypto = require('node:crypto');

function encryptPayload(value, finalKey) {
  const key = Buffer.from(finalKey, 'hex');
  if (key.length !== 32) throw new Error('Final Key harus berupa 64 karakter hex (32 byte).');
  const cipher = crypto.createCipheriv('aes-256-ecb', key, null);
  return Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]).toString('base64');
}
function decryptPayload(value, finalKey) {
  try {
    const key = Buffer.from(finalKey, 'hex');
    if (key.length !== 32) return null;
    const decipher = crypto.createDecipheriv('aes-256-ecb', key, null);
    return Buffer.concat([decipher.update(Buffer.from(value, 'base64')), decipher.final()]).toString('utf8');
  } catch { return null; }
}
function signature(timestamp, message, secret) {
  const key = Buffer.from(secret, 'hex');
  if (!key.length) throw new Error('HMAC secret belum diisi dengan benar.');
  return crypto.createHmac('sha256', key).update(`${timestamp}-${message}`).digest('base64');
}
async function requestGetContact({config, credential, phone, type}) {
  // Sesuai implementasi web asli: /search = profil, /number-detail = daftar tag.
  const endpoint = type === 'search' ? '/v2.8/number-detail' : '/v2.8/search';
  const body = {
    countryCode: config.countryCode || 'id',
    phoneNumber: phone,
    source: type === 'search' ? 'profile' : 'search',
    token: credential.token
  };
  const message = JSON.stringify(body);
  const timestamp = String(Date.now());
  const deviceId = credential.deviceId || config.clientDeviceId;
  const response = await fetch((config.baseUrl || 'https://pbssrv-centralevents.com') + endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-os': config.androidOs || 'android 9',
      'x-app-version': config.appVersion || '8.4.0',
      'x-client-device-id': deviceId || '',
      'x-lang': config.lang || 'en_US',
      'x-token': credential.token,
      'x-req-timestamp': timestamp,
      'x-country-code': config.countryCode || 'id',
      'x-encrypted': '1',
      'x-req-signature': signature(timestamp, message, config.hmacSecretKey)
    },
    body: JSON.stringify({data: encryptPayload(message, credential.finalKey)}),
    signal: AbortSignal.timeout(25000)
  });
  const raw = await response.text();
  let result;
  try { result = JSON.parse(raw); } catch { throw new Error(`Respons API bukan JSON (HTTP ${response.status}).`); }
  if (typeof result.data === 'string') {
    const plain = decryptPayload(result.data, credential.finalKey);
    if (plain) { try { result = JSON.parse(plain); } catch {} }
  }
  const internal = Number(result?.meta?.httpStatusCode ?? response.status);
  if (response.status === 403 || internal === 403) {
    const error = new Error('Credential meminta verifikasi CAPTCHA. Selesaikan melalui aplikasi GetContact resmi lalu perbarui credential.');
    error.captcha = true; throw error;
  }
  if (!response.ok || internal < 200 || internal >= 300) {
    throw new Error(`API menolak permintaan (HTTP ${response.status}, status ${internal}).`);
  }
  return result;
}
module.exports = {requestGetContact};
