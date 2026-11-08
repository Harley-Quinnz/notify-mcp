#!/usr/bin/env node
// notify-server: Claude Code'un uzun işlemler bittiğinde masaüstü bildirimi
// veya e-posta göndermesini sağlayan yerel MCP sunucusu (stdio).
//
// ÖNEMLİ: stdio transport'u stdout'u JSON-RPC için kullanır. Bu dosyada
// console.log KULLANMAYIN; tüm loglar console.error (stderr) ile yazılmalıdır.

import notifier from 'node-notifier';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { sendSelfEmail } from './mailer.js';

function textResult(text, isError = false) {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

const server = new McpServer({ name: 'notify-server', version: '1.0.0' });

// ---------------------------------------------------------------------------
// Araç 1: Masaüstü bildirimi
// ---------------------------------------------------------------------------
server.registerTool(
  'send_desktop_notification',
  {
    title: 'Masaüstü bildirimi gönder',
    description:
      'Kullanıcının bilgisayarında yerel bir Windows masaüstü bildirimi (toast) gösterir. ' +
      'Uzun süren bir işlem bittiğinde kullanıcıyı haberdar etmek için kullan.',
    inputSchema: {
      title: z.string().describe('Bildirim başlığı'),
      message: z.string().describe('Bildirim metni'),
    },
  },
  async ({ title, message }) => {
    try {
      await new Promise((resolve, reject) => {
        // Windows toast'ları kullanıcı kapatana / süre dolana kadar callback'i
        // geciktirebilir. Aracı bekletmemek için kısa bir süre sonra başarılı say.
        const timer = setTimeout(resolve, 3000);
        notifier.notify({ title, message, sound: true }, (err) => {
          clearTimeout(timer);
          if (err) reject(err);
          else resolve();
        });
      });
      return textResult(`Masaüstü bildirimi gönderildi: "${title}"`);
    } catch (err) {
      console.error('[notify-server] Masaüstü bildirimi hatası:', err);
      return textResult(`Masaüstü bildirimi gönderilemedi: ${err?.message ?? err}`, true);
    }
  }
);

// ---------------------------------------------------------------------------
// Araç 2: E-posta bildirimi (Gmail SMTP)
// ---------------------------------------------------------------------------
server.registerTool(
  'send_email_notification',
  {
    title: 'E-posta bildirimi gönder',
    description:
      "Kullanıcının kendi Gmail adresine (.env içindeki EMAIL_USER) yine kendi adresinden " +
      'bir e-posta bildirimi gönderir. Uzun süren bir işlem bittiğinde kullan.',
    inputSchema: {
      subject: z.string().describe('E-posta konusu'),
      message: z.string().describe('E-posta gövdesi (düz metin)'),
    },
  },
  async ({ subject, message }) => {
    try {
      const { user, messageId } = await sendSelfEmail(subject, message);
      return textResult(`E-posta gönderildi (${user}). Mesaj ID: ${messageId}`);
    } catch (err) {
      console.error('[notify-server] E-posta hatası:', err);
      return textResult(`E-posta gönderilemedi: ${err?.message ?? err}`, true);
    }
  }
);

// ---------------------------------------------------------------------------
// Başlat
// ---------------------------------------------------------------------------
const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[notify-server] stdio üzerinden çalışıyor.');
