// Ortak e-posta modülü: hem MCP sunucusu (index.js) hem de otomatik
// "işlem bitti" hook'u (stop-notify.js) bu fonksiyonu kullanır.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import nodemailer from 'nodemailer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ENV_PATH = path.join(__dirname, '.env');

// .env dosyasını her çağrıda yeniden oku; böylece şifre değişince yeniden
// başlatmaya gerek kalmaz. quiet: true -> stdout'a log basma (MCP için şart).
function loadCredentials() {
  dotenv.config({ path: ENV_PATH, override: true, quiet: true });
  const user = process.env.EMAIL_USER?.trim();
  // Gmail uygulama şifreleri boşluklu gösterilir ("abcd efgh ..."); boşlukları temizle.
  const pass = process.env.EMAIL_PASS?.replace(/\s+/g, '');
  if (!user || !pass) {
    throw new Error(`EMAIL_USER veya EMAIL_PASS tanımlı değil. Lütfen ${ENV_PATH} dosyasını doldurun.`);
  }
  return { user, pass };
}

/** Kendi adresinden kendi adresine düz metin e-posta gönderir. */
export async function sendSelfEmail(subject, text) {
  const { user, pass } = loadCredentials();
  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user, pass },
  });
  const info = await transporter.sendMail({ from: user, to: user, subject, text });
  return { user, messageId: info.messageId };
}
