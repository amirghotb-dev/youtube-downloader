#!/usr/bin/env node

/**
 * Telegram Automated Uploader with Parallel Chunking Support
 * Designed for Ninten2 ROM & File Distribution System via Cloudflare Worker Proxy
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const MAX_PART_SIZE = 48 * 1024 * 1024; // 48MB per part to safely stay under Telegram's 50MB Bot API limit

/**
 * Make HTTP/HTTPS request with retries
 */
function request(options, data = null, isMultipart = false, retries = 3, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
        const protocol = options.protocol === 'http:' ? http : https;

        const req = protocol.request({
            ...options,
            timeout: timeoutMs
        }, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(body) });
                } catch (e) {
                    resolve({ status: res.statusCode, headers: res.headers, body });
                }
            });
        });

        req.on('timeout', () => {
            req.destroy(new Error(`HTTP request timed out after ${timeoutMs / 1000}s`));
        });

        req.on('error', (err) => {
            if (retries > 0) {
                console.log(`⚠️ Network error: ${err.message}. Retrying (${retries} left)...`);
                setTimeout(() => {
                    resolve(request(options, data, isMultipart, retries - 1, timeoutMs));
                }, 2000);
            } else {
                reject(err);
            }
        });

        if (data) {
            if (Buffer.isBuffer(data)) {
                req.write(data);
            } else if (typeof data === 'string') {
                req.write(data);
            }
        }

        req.end();
    });
}

/**
 * Upload a single buffer/file chunk to Telegram Bot API sendDocument
 */
async function sendDocumentToTelegram(botToken, chatId, filePath, caption = '', fileName = null) {
    const targetName = fileName || path.basename(filePath);
    const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);

    const fileBuffer = fs.readFileSync(filePath);

    let header = '';
    header += `--${boundary}\r\n`;
    header += `Content-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`;

    if (caption) {
        header += `--${boundary}\r\n`;
        header += `Content-Disposition: form-data; name="caption"\r\n\r\n${caption}\r\n`;
    }

    header += `--${boundary}\r\n`;
    header += `Content-Disposition: form-data; name="document"; filename="${targetName}"\r\n`;
    header += `Content-Type: application/octet-stream\r\n\r\n`;

    const footer = `\r\n--${boundary}--\r\n`;

    const payload = Buffer.concat([
        Buffer.from(header, 'utf-8'),
        fileBuffer,
        Buffer.from(footer, 'utf-8')
    ]);

    const options = {
        hostname: 'api.telegram.org',
        path: `/bot${botToken}/sendDocument`,
        method: 'POST',
        headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': payload.length
        }
    };

    const res = await request(options, payload);

    if (res.status !== 200 || !res.body.ok) {
        throw new Error(`Telegram sendDocument failed (HTTP ${res.status}): ${JSON.stringify(res.body)}`);
    }

    const doc = res.body.result.document;
    return {
        file_id: doc.file_id,
        file_unique_id: doc.file_unique_id,
        file_name: doc.file_name,
        file_size: doc.file_size
    };
}

/**
 * Upload file to Telegram storage with automatic multi-part splitting for files > 48MB
 */
async function uploadFileToTelegram(botToken, chatId, filePath, customFileName = null, workerDomain = 'dl.ninten2.com') {
    if (!fs.existsSync(filePath)) {
        throw new Error(`File not found: ${filePath}`);
    }

    const stats = fs.statSync(filePath);
    const fileSize = stats.size;
    const fileName = customFileName || path.basename(filePath);
    const domain = workerDomain.replace(/^https?:\/\//, '').replace(/\/$/, '');

    console.log(`\n🚀 Preparing Telegram Upload for "${fileName}" (${(fileSize / (1024 * 1024)).toFixed(2)} MB)...`);

    // Case 1: Single file under 48MB
    if (fileSize <= MAX_PART_SIZE) {
        console.log(`📦 File is under 48MB. Uploading single file to Telegram...`);
        const result = await sendDocumentToTelegram(botToken, chatId, filePath, `🎮 ${fileName}`, fileName);

        const publicUrl = `https://${domain}/?file_id=${result.file_id}`;
        console.log(`✅ Upload complete! Public Link: ${publicUrl}`);

        return {
            file_id: result.file_id,
            name: fileName,
            size: fileSize,
            public_url: publicUrl,
            parts_count: 1,
            parts: [{ part: 1, file_id: result.file_id, name: fileName, url: publicUrl }]
        };
    }

    // Case 2: Large file > 48MB -> Split into ~45MB parts
    console.log(`✂️ File exceeds 48MB. Splitting into 45MB parts for Telegram upload...`);

    const tempDir = fs.mkdtempSync(path.join(process.cwd(), 'temp_tg_parts_'));
    const partPrefix = path.join(tempDir, 'part_');

    try {
        execSync(`split -b 45m "${filePath}" "${partPrefix}"`);
        const createdParts = fs.readdirSync(tempDir).filter(f => f.startsWith('part_')).sort();

        console.log(`📦 Split into ${createdParts.length} part(s). Uploading to Telegram channel...`);

        const uploadedParts = [];

        for (let i = 0; i < createdParts.length; i++) {
            const partFile = createdParts[i];
            const partPath = path.join(tempDir, partFile);
            const partName = `${fileName}.part${i + 1}`;

            console.log(`   ⏳ Uploading Part ${i + 1}/${createdParts.length}: ${partName}...`);
            const tgPart = await sendDocumentToTelegram(botToken, chatId, partPath, `📦 ${partName} (${i + 1}/${createdParts.length})`, partName);

            const partUrl = `https://${domain}/?file_id=${tgPart.file_id}`;
            uploadedParts.push({
                part: i + 1,
                file_id: tgPart.file_id,
                name: partName,
                url: partUrl
            });
        }

        const mainUrl = uploadedParts[0].url;

        console.log(`\n🎉 All ${uploadedParts.length} parts uploaded to Telegram!`);
        console.log(`🌐 Primary Download Link: ${mainUrl}`);

        return {
            file_id: uploadedParts[0].file_id,
            name: fileName,
            size: fileSize,
            public_url: mainUrl,
            parts_count: uploadedParts.length,
            parts: uploadedParts
        };

    } finally {
        try {
            fs.rmSync(tempDir, { recursive: true, force: true });
        } catch (e) {}
    }
}

// CLI Execution Support
async function main() {
    const args = process.argv.slice(2);
    const params = {};
    for (let i = 0; i < args.length; i++) {
        if (args[i].startsWith('--')) {
            const key = args[i].substring(2);
            const val = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true;
            params[key] = val;
        }
    }

    const botToken = params['bot-token'] || process.env.TELEGRAM_BOT_TOKEN;
    const chatId = params['chat-id'] || process.env.TELEGRAM_CHAT_ID;
    const filePath = params['file'] || params['path'];
    const workerDomain = params['worker-domain'] || process.env.CLOUDFLARE_WORKER_DOMAIN || 'dl.ninten2.com';
    const customName = params['name'] || null;

    if (!botToken) {
        console.error('❌ Error: Missing Telegram Bot Token. Pass --bot-token or set TELEGRAM_BOT_TOKEN env.');
        process.exit(1);
    }

    if (!chatId) {
        console.error('❌ Error: Missing Telegram Chat ID. Pass --chat-id or set TELEGRAM_CHAT_ID env.');
        process.exit(1);
    }

    if (!filePath) {
        console.error('❌ Error: Missing file path. Pass --file /path/to/game.nsp');
        process.exit(1);
    }

    try {
        const result = await uploadFileToTelegram(botToken, chatId, filePath, customName, workerDomain);

        console.log('\n=============================================');
        console.log('🎉 TELEGRAM UPLOAD COMPLETE!');
        console.log(`🎮 File Name:    ${result.name}`);
        console.log(`📦 Size:         ${(result.size / (1024 * 1024)).toFixed(2)} MB`);
        console.log(`🧩 Parts Count:  ${result.parts_count}`);
        console.log(`🌐 Direct Link:  ${result.public_url}`);
        console.log('=============================================\n');

        if (process.env.GITHUB_OUTPUT) {
            fs.appendFileSync(process.env.GITHUB_OUTPUT, `public_url=${result.public_url}\n`);
            fs.appendFileSync(process.env.GITHUB_OUTPUT, `file_id=${result.file_id}\n`);
            fs.appendFileSync(process.env.GITHUB_OUTPUT, `file_name=${result.name}\n`);
        }
    } catch (err) {
        console.error(`\n❌ Error: ${err.message}`);
        process.exit(1);
    }
}

if (require.main === module) {
    main();
}

module.exports = {
    sendDocumentToTelegram,
    uploadFileToTelegram
};
