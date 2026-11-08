#!/usr/bin/env node
// Claude Code "Stop" hook'u: Claude her cevabını bitirdiğinde sesli uyarı çalar
// ve "işlem tamamlandı" e-postası gönderir.
//
// Koşullar (kanal bazında):
//   1. Kullanıcı son mesajında o kanalı istemediğini söylediyse atlanır
//      ("ses çalma", "e-posta gönderme", "bildirim gönderme", "sessiz" ...).
//      "sadece ses gönder" / "sadece e-posta gönder" -> yalnızca istenen kanal.
//   2. Kullanıcı sohbetin daha önceki bir mesajında kalıcı olarak kapattıysa
//      ("bu sohbet boyunca ...", "ben söyleyene kadar ...", "bildirimleri kapat")
//      tekrar açana kadar ("bildirimleri tekrar aç") atlanır. Kalıcılık sohbetin
//      kendi transcript'inden hesaplanır; yeni sohbet varsayılanla başlar.
//   3. Claude bu turda aynı bildirimi MCP aracıyla zaten gönderdiyse atlanır
//      (çift e-posta / çift ses olmasın diye).
//
// Claude Code, hook'a stdin üzerinden JSON gönderir (session_id, cwd,
// transcript_path, ...). Hatalar ve atlanan bildirimler stop-notify.log
// dosyasına yazılır. NOTIFY_DRY_RUN=1 ile hiçbir şey göndermeden kararı yazdırır.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sendSelfEmail } from './mailer.js';
import { decide } from './prompt-intent.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_PATH = path.join(__dirname, 'stop-notify.log');
const MAX_SUMMARY_CHARS = 4000;
const DRY_RUN = process.env.NOTIFY_DRY_RUN === '1';

function log(message) {
  try {
    fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${message}\n`);
  } catch {}
}

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

function textOf(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter((c) => c?.type === 'text')
    .map((c) => c.text)
    .join('\n')
    .trim();
}

// Kullanıcının yazmadığı "user" kayıtları: kesinti notları, ! komut çıktıları vb.
const NON_PROMPT_PREFIX = /^(?:\[Request interrupted|<bash-|<local-command-|Caveat:)/;

/** Gerçek kullanıcı mesajıysa metnini, değilse '' döndürür. */
function promptText(entry) {
  // Araç sonuçları (toolUseResult), skill/sistem içerikleri (isMeta) ve
  // sıkıştırma özetleri (isCompactSummary) kullanıcının yazdığı mesaj değildir.
  if (entry.type !== 'user' || entry.isMeta || entry.toolUseResult || entry.isCompactSummary) return '';
  const text = textOf(entry.message?.content);
  return text && !NON_PROMPT_PREFIX.test(text) ? text : '';
}

/**
 * Transcript'i (JSONL) baştan sona okur ve şunları bulur:
 *  - prompts:       sohbetteki tüm gerçek kullanıcı mesajları (eskiden yeniye)
 *  - lastAssistant: Claude'un son metin cevabı
 *  - toolsUsed:     son kullanıcı mesajından bu yana Claude'un çağırdığı araçlar
 */
function analyzeTranscript(transcriptPath) {
  const out = { prompts: [], lastAssistant: '', toolsUsed: new Set() };
  let lines;
  try {
    lines = fs.readFileSync(transcriptPath, 'utf8').split('\n');
  } catch {
    return out;
  }
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.isSidechain) continue; // alt ajan (subagent) kayıtları

    if (entry.type === 'assistant') {
      const content = entry.message?.content;
      const text = textOf(content);
      if (text) out.lastAssistant = text;
      if (Array.isArray(content)) {
        for (const c of content) if (c?.type === 'tool_use' && c.name) out.toolsUsed.add(c.name);
      }
      continue;
    }

    const prompt = promptText(entry);
    if (prompt) {
      out.prompts.push(prompt);
      out.toolsUsed = new Set(); // yeni tur başladı
    }
  }
  return out;
}

function playSound() {
  return new Promise((resolve, reject) => {
    let child;
    if (process.platform === 'win32') {
      child = spawn(
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          '[Console]::Beep(523,150); [Console]::Beep(659,150); [Console]::Beep(784,150); [Console]::Beep(1046,300)',
        ],
        { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true }
      );
    } else if (process.platform === 'darwin') {
      child = spawn('afplay', ['/System/Library/Sounds/Glass.aiff'], { stdio: ['ignore', 'ignore', 'pipe'] });
    } else {
      return resolve(); // Linux: varsayılan bir ses komutu yok, sessizce geç.
    }
    const started = Date.now();
    let stderr = '';
    child.stderr?.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        log(`Ses çalındı (${Date.now() - started} ms)`);
        resolve();
      } else {
        reject(new Error(`ses komutu ${code} koduyla çıktı: ${stderr.trim() || '(çıktı yok)'}`));
      }
    });
  });
}

function buildEmail(input, summary) {
  const cwd = input.cwd || process.cwd();
  const project = path.basename(cwd) || cwd;
  const when = new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' });
  if (summary.length > MAX_SUMMARY_CHARS) {
    summary = summary.slice(0, MAX_SUMMARY_CHARS) + '\n\n[... kısaltıldı]';
  }
  const subject = `✅ Claude Code işlemi tamamlandı: ${project}`;
  const text = [
    'Claude Code bir işlemi tamamladı.',
    '',
    `Klasör : ${cwd}`,
    `Zaman  : ${when}`,
    input.session_id ? `Oturum : ${input.session_id}` : null,
    '',
    '--- Son cevap ---',
    summary || '(özet bulunamadı)',
  ]
    .filter((l) => l !== null)
    .join('\n');
  return { subject, text };
}

async function main() {
  let input = {};
  try {
    input = JSON.parse((await readStdin()) || '{}');
  } catch {
    // geçersiz JSON: varsayılanlarla devam et
  }

  const transcript = input.transcript_path
    ? analyzeTranscript(input.transcript_path)
    : { prompts: [], lastAssistant: '', toolsUsed: new Set() };

  const decision = decide(transcript.prompts);
  const used = [...transcript.toolsUsed];
  const claudeSentEmail = used.some((n) => n.endsWith('send_email_notification'));
  const claudeSentDesktop = used.some((n) => n.endsWith('send_desktop_notification'));

  const skip = {
    sound: !decision.sound.send
      ? `kullanıcı istemedi: ${decision.sound.reason}`
      : claudeSentDesktop
        ? 'Claude zaten masaüstü bildirimi gönderdi'
        : null,
    email: !decision.email.send
      ? `kullanıcı istemedi: ${decision.email.reason}`
      : claudeSentEmail
        ? 'Claude zaten e-posta gönderdi'
        : null,
  };

  if (DRY_RUN) {
    process.stdout.write(
      JSON.stringify(
        {
          lastPrompt: transcript.prompts.at(-1) ?? '',
          promptCount: transcript.prompts.length,
          sound: skip.sound ?? `çalınacak (${decision.sound.reason})`,
          email: skip.email ?? `gönderilecek (${decision.email.reason})`,
        },
        null,
        2
      ) + '\n'
    );
    return;
  }

  const project = path.basename(input.cwd || process.cwd());
  for (const [channel, reason] of Object.entries(skip)) {
    if (reason) log(`${channel === 'sound' ? 'Ses' : 'E-posta'} atlandı (${reason}) — ${project}`);
  }

  const summary =
    (typeof input.last_assistant_message === 'string' && input.last_assistant_message.trim()) ||
    transcript.lastAssistant;

  const jobs = [];
  if (!skip.sound) jobs.push(playSound().catch((err) => log(`Ses çalınamadı: ${err?.message || err}`)));
  if (!skip.email) {
    const { subject, text } = buildEmail(input, summary);
    jobs.push(sendSelfEmail(subject, text));
  }

  const results = await Promise.allSettled(jobs);
  const failed = results.find((r) => r.status === 'rejected');
  if (failed) throw failed.reason;
}

main().catch((err) => {
  log(err?.stack || String(err));
  console.error(`[stop-notify] Bildirim gönderilemedi: ${err?.message || err}`);
  process.exit(1);
});
