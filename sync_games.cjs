#!/usr/bin/env node

/**
 * Nintendo Switch Games Automated Sync & Upload Pipeline
 * For GitHub Actions & External Worker Repositories
 * 
 * Flow:
 * 1. Queries website API for pending NSWPedia games in queue (/api/v1/games/queue/pending)
 * 2. Scrapes metadata, cover, screenshots, and direct download mirrors using nswpedia_scraper.cjs
 * 3. Downloads Base Game, Updates, DLCs via high-speed pipeline (aria2 / stream)
 * 4. Uploads files to AbreHamrahi Cloud with structured folders (Nintendo_Switch/<Game_Title>/...)
 * 5. Cleans up local files to preserve runner disk space
 * 6. Sends public Hamrahi links and metadata back to website API (/api/v1/games/queue/complete)
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const {
    scrapeGame,
    downloadFile,
    formatBytes,
    sanitizeFilename
} = require('./nswpedia_scraper.cjs');

const {
    getAccessToken,
    resolveFolderPath,
    uploadFileToHamrahi
} = require('./hamrahi_uploader.cjs');

// Parse CLI flags
const args = process.argv.slice(2);
const params = {};
for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
        const key = args[i].substring(2);
        const val = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true;
        params[key] = val;
    }
}

const API_BASE_URL = (params['api-url'] || process.env.SITE_URL || process.env.APP_URL || 'https://ninten2.ir').replace(/\/$/, '');
const SYNC_TOKEN = params['api-token'] || process.env.SYNC_API_TOKEN || 'ninten2-sync-secret-key-2026';
const REFRESH_TOKEN = params['refresh-token'] || process.env.ABREHAMRAHI_REFRESH_TOKEN;
const DEST_DIR = params['dest-dir'] || path.join(process.cwd(), 'downloads');
const SINGLE_URL = params['single-url'] || null;

/**
 * Generic JSON HTTP Request helper
 */
function apiRequest(endpoint, method = 'GET', data = null) {
    return new Promise((resolve, reject) => {
        const urlStr = `${API_BASE_URL}${endpoint}`;
        const parsedUrl = new URL(urlStr);
        const protocol = parsedUrl.protocol === 'https:' ? https : http;

        const reqOptions = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
            path: parsedUrl.pathname + parsedUrl.search,
            method: method,
            headers: {
                'X-SYNC-TOKEN': SYNC_TOKEN,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'User-Agent': 'Ninten2-GitHub-Sync-Worker/1.0'
            },
            rejectUnauthorized: false
        };

        const req = protocol.request(reqOptions, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(body);
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve(parsed);
                    } else {
                        reject(new Error(`API Error (HTTP ${res.statusCode}): ${parsed.message || body}`));
                    }
                } catch (e) {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve(body);
                    } else {
                        reject(new Error(`HTTP ${res.statusCode}: ${body}`));
                    }
                }
            });
        });

        req.on('error', reject);

        if (data) {
            req.write(JSON.stringify(data));
        }

        req.end();
    });
}

/**
 * Download a file via aria2c (if available) or fallback to internal stream downloader
 */
async function downloadRomFile(url, targetPath) {
    // Check if aria2c is installed
    let hasAria2 = false;
    try {
        execSync('which aria2c', { stdio: 'ignore' });
        hasAria2 = true;
    } catch {}

    if (hasAria2) {
        console.log(`    ⚡ Downloading with aria2c (16 connections)...`);
        const targetDir = path.dirname(targetPath);
        const targetFile = path.basename(targetPath);
        const cmd = `aria2c -x 16 -s 16 -k 1M --file-allocation=none --dir="${targetDir}" --out="${targetFile}" "${url}"`;
        execSync(cmd, { stdio: 'inherit' });
        const stats = fs.statSync(targetPath);
        return {
            destPath: targetPath,
            totalBytes: stats.size
        };
    } else {
        console.log(`    📥 Downloading via Node.js high-speed stream...`);
        let lastRender = 0;
        return await downloadFile(url, targetPath, {
            onProgress: (prog) => {
                const now = Date.now();
                if (now - lastRender >= 300 || prog.percentage === 100) {
                    lastRender = now;
                    const pct = prog.percentage.toFixed(1);
                    const downStr = formatBytes(prog.downloadedBytes);
                    const totalStr = formatBytes(prog.totalBytes);
                    const speedStr = formatBytes(prog.speedBytesPerSec) + '/s';
                    process.stdout.write(`\r    [${pct}%] ${downStr}/${totalStr} | ⚡ ${speedStr}   `);
                }
            }
        });
    }
}

/**
 * Clean and format clean directory folder name
 */
function cleanFolderName(title) {
    return (title || 'Nintendo_Switch_Game')
        .replace(/[^a-zA-Z0-9_\- ]/g, '')
        .trim()
        .replace(/\s+/g, '_');
}

/**
 * Main Runner Loop
 */
async function run() {
    console.log('===============================================================');
    console.log('🚀 Ninten2 Nintendo Switch Games Sync & Auto-Uploader Pipeline');
    console.log('===============================================================');
    console.log(`🌐 Target Website API: ${API_BASE_URL}`);

    if (!REFRESH_TOKEN) {
        console.error('❌ Error: Missing ABREHAMRAHI_REFRESH_TOKEN environment variable.');
        process.exit(1);
    }

    if (!fs.existsSync(DEST_DIR)) {
        fs.mkdirSync(DEST_DIR, { recursive: true });
    }

    // 1. Get Pending Items from API (or use single URL)
    let queueItems = [];
    if (SINGLE_URL) {
        queueItems = [{
            id: 0,
            nswpedia_url: SINGLE_URL,
            system_platform: 'Nintendo Switch',
        }];
    } else {
        console.log('📡 Checking website API for pending games to download...');
        try {
            const res = await apiRequest('/api/v1/games/queue/pending?limit=1');
            queueItems = res.data || [];
        } catch (err) {
            console.error(`❌ Failed to connect to API: ${err.message}`);
            process.exit(1);
        }
    }

    if (queueItems.length === 0) {
        console.log('✅ No pending games in queue to download. Everything is up to date!');
        process.exit(0);
    }

    console.log(`✨ Found ${queueItems.length} game(s) to process.\n`);

    // 2. Authenticate with AbreHamrahi
    console.log('🔑 Authenticating with AbreHamrahi Cloud Storage...');
    const accessToken = await getAccessToken(REFRESH_TOKEN);
    console.log('✅ AbreHamrahi authentication successful!\n');

    for (const item of queueItems) {
        console.log('---------------------------------------------------------------');
        console.log(`🎮 Processing Queue Item #${item.id}: ${item.nswpedia_url}`);

        // Notify API start
        if (item.id > 0) {
            try {
                await apiRequest('/api/v1/games/queue/start', 'POST', { queue_id: item.id });
                console.log(`📌 Marked queue item #${item.id} as processing.`);
            } catch (err) {
                console.warn(`⚠️ Warning: Could not mark start in API: ${err.message}`);
            }
        }

        try {
            // 3. Scrape NSWPedia Game Page
            console.log(`🔍 Scraping game page and resolving direct ROM mirrors...`);
            const gameData = await scrapeGame(item.nswpedia_url, { resolveMirrors: true });

            console.log(`\n📋 Extracted Game Details:`);
            console.log(`    Title:     ${gameData.title}`);
            console.log(`    Title ID:  ${gameData.titleId || 'N/A'}`);
            console.log(`    Firmware:  ${gameData.requiredFirmware || 'N/A'}`);
            console.log(`    Mirrors:   ${gameData.downloads.length} mirror link(s) found\n`);

            // 4. Select candidate download files
            // Filter direct links (prioritize Vikingfile/Direct, then 1Fichier, then Datanodes)
            const availableDownloads = gameData.downloads.filter(d => d.directUrl && !d.directUrl.includes('placeholder'));

            // Sort: prioritize Vikingfile
            availableDownloads.sort((a, b) => {
                if (a.directUrl.includes('vikingfile.com')) return -1;
                if (b.directUrl.includes('vikingfile.com')) return 1;
                return 0;
            });

            // Group by unique file (Base Game, Update, DLC)
            const selectedFiles = [];
            const seenTypes = new Set();

            for (const mirror of availableDownloads) {
                const uniqueKey = `${mirror.type}_${mirror.version || 'v0'}_${mirror.name.toLowerCase()}`;
                if (!seenTypes.has(uniqueKey)) {
                    seenTypes.add(uniqueKey);
                    selectedFiles.push(mirror);
                }
            }

            if (selectedFiles.length === 0) {
                throw new Error('No downloadable direct ROM links found on the NSWPedia page.');
            }

            console.log(`📦 Selected ${selectedFiles.length} file(s) for download & AbreHamrahi upload.`);

            const uploadedFiles = [];
            const gameFolderName = `Nintendo_Switch/${cleanFolderName(gameData.title)}`;

            for (let i = 0; i < selectedFiles.length; i++) {
                const fileItem = selectedFiles[i];
                console.log(`\n---------------------------------------------------------------`);
                console.log(`[${i + 1}/${selectedFiles.length}] 📥 Processing: ${fileItem.name} (${fileItem.size || 'Size N/A'})`);
                console.log(`    Type:   ${fileItem.type} | Format: ${fileItem.format || 'NSP'}`);
                console.log(`    Source: ${fileItem.directUrl}`);

                // Determine filename and path
                const ext = fileItem.format ? `.${fileItem.format.toLowerCase()}` : '.nsp';
                let safeName = sanitizeFilename(fileItem.name);
                if (!safeName.endsWith(ext)) {
                    safeName += ext;
                }

                const localFilePath = path.join(DEST_DIR, safeName);

                // Step A: Download
                console.log(`    Saving locally to: ${localFilePath}`);
                const dlResult = await downloadRomFile(fileItem.directUrl, localFilePath);
                console.log(`\n    ✅ Downloaded successfully: ${formatBytes(dlResult.totalBytes)}`);

                // Step B: Upload to AbreHamrahi Cloud
                const subFolder = fileItem.type === 'Base Game' ? 'Base_Game' : (fileItem.type === 'Update' ? 'Updates' : 'DLC');
                const targetHamrahiFolder = `${gameFolderName}/${subFolder}`;

                console.log(`    ☁️ Resolving AbreHamrahi folder: "${targetHamrahiFolder}"...`);
                const folderId = await resolveFolderPath(accessToken, targetHamrahiFolder);

                console.log(`    ☁️ Uploading to AbreHamrahi...`);
                const uploadResult = await uploadFileToHamrahi(accessToken, localFilePath, folderId, safeName);

                console.log(`    🎉 Upload Complete! Public Link: ${uploadResult.public_url}`);

                // Step C: Delete local file immediately to free disk space!
                if (fs.existsSync(localFilePath)) {
                    fs.unlinkSync(localFilePath);
                    console.log(`    🧹 Cleaned up temporary local file: ${safeName}`);
                }

                // Step D: Record file metadata
                let fileTypeKey = 'base_game';
                if (fileItem.type === 'Update') fileTypeKey = 'update';
                else if (fileItem.type === 'DLC') fileTypeKey = 'dlc';

                uploadedFiles.push({
                    file_type: fileTypeKey,
                    title: safeName,
                    version: fileItem.version || 'v1.0.0',
                    file_size: formatBytes(uploadResult.size),
                    file_format: fileItem.format || 'NSP',
                    part_number: 1,
                    total_parts: 1,
                    server_name: 'سرور اختصاصی مستقیم ابر همراهی (نیم‌بها)',
                    download_url: uploadResult.public_url,
                    folder_path: targetHamrahiFolder,
                    hamrahi_id: uploadResult.id,
                });
            }

            // 5. Complete task in Website API
            console.log(`\n📤 Sending ${uploadedFiles.length} download links and metadata back to website API...`);
            const completePayload = {
                queue_id: item.id,
                game_title: gameData.title,
                title_id: gameData.titleId || null,
                scraped_data: {
                    title: gameData.title,
                    title_id: gameData.titleId,
                    required_firmware: gameData.requiredFirmware,
                    developer: gameData.developer || 'Nintendo',
                    publisher: gameData.publisher || 'Nintendo',
                    release_date: gameData.releaseDate,
                    format: gameData.format || 'NSP',
                    cover_image: gameData.coverImage,
                    screenshots: gameData.screenshots || [],
                    summary: gameData.description ? gameData.description.substring(0, 300) : '',
                    description: gameData.description || '',
                    genres: gameData.genres || ['Action', 'Adventure'],
                },
                uploaded_files: uploadedFiles,
            };

            if (item.id > 0) {
                const completeRes = await apiRequest('/api/v1/games/queue/complete', 'POST', completePayload);
                console.log(`✅ API response: ${completeRes.message || 'Complete!'}`);
            }

            console.log(`\n🎉 Queue Item #${item.id} (${gameData.title}) completed successfully!`);

        } catch (taskErr) {
            console.error(`\n❌ Error processing game ${item.nswpedia_url}: ${taskErr.message}`);

            if (item.id > 0) {
                try {
                    await apiRequest('/api/v1/games/queue/fail', 'POST', {
                        queue_id: item.id,
                        error_message: taskErr.message
                    });
                    console.log(`⚠️ Logged error in website API.`);
                } catch (failApiErr) {
                    console.error(`Failed to report error to API: ${failApiErr.message}`);
                }
            }
        }
    }

    console.log('\n===============================================================');
    console.log('🏁 All requested tasks in this run completed!');
    console.log('===============================================================\n');
}

run().catch(err => {
    console.error('Fatal execution error:', err);
    process.exit(1);
});
