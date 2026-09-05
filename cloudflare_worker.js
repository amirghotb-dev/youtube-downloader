/**
 * Cloudflare Worker for Telegram High-Speed Direct File Proxy & Streaming
 * 
 * Features:
 * - Direct bypass of Iranian ISP Telegram filtering without VPN
 * - Streaming response piping for files of any size
 * - Supports both ?file_id=... query parameters and /file/:file_id paths
 * - Supports Content-Disposition headers for proper file saving
 * - CORS & Anti-Referer protection
 * 
 * Deployment:
 * 1. Copy this code into your Cloudflare Worker Dashboard (Workers & Pages -> Create Worker)
 * 2. Add Environment Variable: BOT_TOKEN = "your_telegram_bot_api_token"
 * 3. Deploy & connect your custom domain (e.g. dl.ninten2.com)
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 1. Handle CORS Preflight Options Request
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
          'Access-Control-Allow-Headers': 'Range, Content-Type, Authorization',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    // 2. Parse file_id from search query ?file_id=... or path /file/:file_id
    let fileId = url.searchParams.get('file_id') || url.searchParams.get('id');

    if (!fileId) {
      const pathParts = url.pathname.split('/').filter(Boolean);
      if (pathParts.length >= 2 && pathParts[0] === 'file') {
        fileId = pathParts[1];
      }
    }

    // Health check / Homepage Landing
    if (!fileId || url.pathname === '/' && !url.search) {
      return new Response(
        JSON.stringify({
          status: 'online',
          service: 'Ninten2 Direct Download CDN Proxy',
          message: 'Cloudflare Worker is running active.',
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
          },
        }
      );
    }

    const botToken = env.BOT_TOKEN || env.TELEGRAM_BOT_TOKEN;
    if (!botToken) {
      return new Response(
        JSON.stringify({ error: 'Server Error: BOT_TOKEN environment variable is not configured in Cloudflare Worker.' }),
        { status: 500, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
      );
    }

    try {
      // 3. Query Telegram Bot API for file path
      const tgApiUrl = `https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`;
      const tgRes = await fetch(tgApiUrl);
      const tgData = await tgRes.json();

      if (!tgData.ok || !tgData.result || !tgData.result.file_path) {
        return new Response(
          JSON.stringify({ error: 'Telegram File Not Found or Invalid File ID', details: tgData }),
          { status: 404, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
        );
      }

      const filePath = tgData.result.file_path;
      const downloadUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`;
      const fileName = filePath.split('/').pop() || 'download.rar';

      // Forward request headers (e.g. Range header for chunked downloads)
      const forwardHeaders = new Headers();
      if (request.headers.has('Range')) {
        forwardHeaders.set('Range', request.headers.get('Range'));
      }

      // 4. Stream binary file from Telegram API back to client
      const fileStreamRes = await fetch(downloadUrl, {
        headers: forwardHeaders
      });

      const responseHeaders = new Headers(fileStreamRes.headers);

      // Set optimized headers for download managers and web browsers
      responseHeaders.set('Access-Control-Allow-Origin', '*');
      responseHeaders.set('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);
      responseHeaders.set('Referrer-Policy', 'no-referrer');
      responseHeaders.set('Cache-Control', 'public, max-age=31536000, immutable');
      responseHeaders.set('X-Content-Type-Options', 'nosniff');

      return new Response(fileStreamRes.body, {
        status: fileStreamRes.status,
        statusText: fileStreamRes.statusText,
        headers: responseHeaders,
      });

    } catch (err) {
      return new Response(
        JSON.stringify({ error: 'Proxy Streaming Failed', message: err.message }),
        { status: 500, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
      );
    }
  },
};
