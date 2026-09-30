import 'dotenv/config';

const command = process.argv[2] || 'info';
const botToken = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
const apiBase = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';

if (!botToken) throw new Error('Set TELEGRAM_BOT_TOKEN or BOT_TOKEN');

async function telegramCommand(method: string, body?: Record<string, unknown>) {
  const response = await fetch(`${apiBase}/bot${botToken}/${method}`, body ? {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  } : undefined);
  const result = await response.json() as { ok?: boolean; description?: string; result?: unknown };
  if (!response.ok || !result.ok) {
    throw new Error(`Telegram ${method} failed: ${result.description || `HTTP ${response.status}`}`);
  }
  return result.result;
}

async function main() {
  if (command === 'info') {
    console.log(JSON.stringify(await telegramCommand('getWebhookInfo'), null, 2));
    return;
  }
  if (command === 'delete') {
    console.log(JSON.stringify({ deleted: true, result: await telegramCommand('deleteWebhook') }, null, 2));
    return;
  }
  if (command === 'set') {
    const webAppUrl = process.env.WEBAPP_URL;
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (!webAppUrl) throw new Error('Set WEBAPP_URL');
    if (!secret || !/^[A-Za-z0-9_-]{1,256}$/.test(secret)) {
      throw new Error('TELEGRAM_WEBHOOK_SECRET must contain 1-256 characters: A-Z, a-z, 0-9, _ or -');
    }
    if (secret === botToken) throw new Error('TELEGRAM_WEBHOOK_SECRET must be independent from the Telegram bot token');
    const webhookUrl = new URL('/api/telegram-webhook', webAppUrl).toString();
    const result = await telegramCommand('setWebhook', {
      url: webhookUrl,
      secret_token: secret,
      allowed_updates: ['message', 'callback_query', 'chat_member', 'my_chat_member'],
      drop_pending_updates: false,
    });
    console.log(JSON.stringify({ configured: true, webhookUrl, result }, null, 2));
    return;
  }
  throw new Error(`Unknown command: ${command}. Use info, set, or delete.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
