#!/usr/bin/env node

/**
 * Nintendo Switch Games Automated Sync & Upload Pipeline
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
    cleanGameTitle,
    generateRomFilename,
    formatBytes,
    sanitizeFilename
} = require('./nswpedia_scraper.cjs');

const {
    getAccessToken,
    resolveFolderPath,
    findExistingFileInHamrahi,
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
const ZIP_PASSWORD = params['zip-password'] || process.env.ZIP_PASSWORD || 'ninten2.ir';

/**
 * Package a downloaded file into a password-protected zip file
 */
function createProtectedZip(sourceFilePath, outputZipPath, password = ZIP_PASSWORD) {
    const sourceExt = path.extname(sourceFilePath).toLowerCase();
    const tempExtractDir = path.join(path.dirname(sourceFilePath), `ext_${Date.now()}_${Math.floor(Math.random() * 1000)}`);
    
    let extracted = false;

    // Check if zip command is available
    let hasZip = false;
    try {
        execSync('which zip', { stdio: 'ignore' });
        hasZip = true;
    } catch {}

    if (!hasZip) {
        throw new Error('zip command line utility is not available on this system.');
    }

    // Try extracting if it is a regular zip/rar/7z archive so the user gets clean internal files
    if (['.zip', '.rar', '.7z'].includes(sourceExt)) {
        try {
            fs.mkdirSync(tempExtractDir, { recursive: true });
            
            let has7z = false;
            try { execSync('which 7z', { stdio: 'ignore' }); has7z = true; } catch {}
            
            let hasUnzip = false;
            try { execSync('which unzip', { stdio: 'ignore' }); hasUnzip = true; } catch {}

            if (sourceExt === '.zip' && hasUnzip) {
                execSync(`unzip -q -o "${sourceFilePath}" -d "${tempExtractDir}"`, { stdio: 'ignore' });
                extracted = true;
            } else if (has7z) {
                execSync(`7z x -y -o"${tempExtractDir}" "${sourceFilePath}"`, { stdio: 'ignore' });
                extracted = true;
            }
        } catch (e) {
            extracted = false;
        }
    }

    if (fs.existsSync(outputZipPath)) {
        fs.unlinkSync(outputZipPath);
    }

    if (extracted) {
        // Zip contents of extracted directory
        const cmd = `cd "${tempExtractDir}" && zip -q -1 -r -P "${password}" "${outputZipPath}" .`;
        execSync(cmd, { stdio: 'ignore' });
        
        // Clean extract dir
        fs.rmSync(tempExtractDir, { recursive: true, force: true });
    } else {
        // Zip the source file directly
        const sourceDir = path.dirname(sourceFilePath);
        const sourceBase = path.basename(sourceFilePath);
        const cmd = `cd "${sourceDir}" && zip -q -1 -P "${password}" "${outputZipPath}" "${sourceBase}"`;
        execSync(cmd, { stdio: 'ignore' });
    }

    return outputZipPath;
}

/**
 * Generic JSON HTTP Request helper
 */
function apiRequest(endpoint, method = 'GET', data = null) {
    return new Promise((resolve, reject) => {
        const urlStr = `${API_BASE_URL}${endpoint}`;
        const parsedUrl = new URL(urlStr);
        const protocol = parsedUrl.protocol === 'https:' ? https : http;

        let payload = null;
        if (data !== null && data !== undefined) {
            if (Buffer.isBuffer(data)) {
                payload = data;
            } else if (typeof data === 'string') {
                payload = Buffer.from(data, 'utf-8');
            } else {
                payload = Buffer.from(JSON.stringify(data), 'utf-8');
            }
        }

        const headers = {
            'X-SYNC-TOKEN': SYNC_TOKEN,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'User-Agent': 'Ninten2-GitHub-Sync-Worker/1.0'
        };

        if (payload) {
            headers['Content-Length'] = payload.length;
        }

        const reqOptions = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
            path: parsedUrl.pathname + parsedUrl.search,
            method: method,
            headers: headers,
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

        if (payload) {
            req.write(payload);
        }

        req.end();
    });
}

/**
 * Resolve any HTTP 301/302 redirects to find the ultimate direct storage download URL
 */
async function resolveFinalRedirectUrl(initialUrl, maxRedirects = 5) {
    let currentUrl = initialUrl;
    for (let i = 0; i < maxRedirects; i++) {
        try {
            const parsed = new URL(currentUrl);
            const protocol = parsed.protocol === 'https:' ? https : http;
            const res = await new Promise((resolve, reject) => {
                const req = protocol.request(currentUrl, {
                    method: 'GET',
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                        'Range': 'bytes=0-10'
                    }
                }, resolve);
                req.on('error', reject);
                req.setTimeout(6000, () => { req.destroy(); resolve(null); });
                req.end();
            });

            if (res && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                currentUrl = new URL(res.headers.location, currentUrl).href;
            } else {
                break;
            }
        } catch (e) {
            break;
        }
    }
    return currentUrl;
}

/**
 * Download a file via aria2c (if available) or fallback to internal stream downloader
 */
async function downloadRomFile(url, targetPath) {
    const finalUrl = await resolveFinalRedirectUrl(url);

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
        try {
            const cmd = `aria2c -x 16 -s 16 -k 1M --allow-overwrite=true --auto-file-renaming=false --file-allocation=none --dir="${targetDir}" --out="${targetFile}" "${finalUrl}"`;
            execSync(cmd, { stdio: 'inherit' });
        } catch (ariaErr) {
            console.warn(`    ⚠️ aria2c encountered an issue, falling back to direct stream download...`);
        }

        if (fs.existsSync(targetPath)) {
            const stats = fs.statSync(targetPath);
            // Check if downloaded file is accidentally an HTML error/redirect page
            if (stats.size < 150 * 1024) {
                try {
                    const sample = fs.readFileSync(targetPath, 'utf8').substring(0, 500);
                    if (sample.includes('<html') || sample.includes('<!DOCTYPE') || sample.includes('Redirecting') || sample.includes('Cloudflare')) {
                        console.warn(`    ⚠️ Downloaded file is an HTML redirect/error page (${stats.size} bytes). Re-downloading with stream...`);
                        fs.unlinkSync(targetPath);
                    }
                } catch {}
            }
        }
    }

    if (!fs.existsSync(targetPath)) {
        console.log(`    📥 Downloading via Node.js high-speed stream...`);
        let lastRender = 0;
        return await downloadFile(finalUrl, targetPath, {
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

    const finalStats = fs.statSync(targetPath);
    return {
        destPath: targetPath,
        totalBytes: finalStats.size
    };
}

/**
 * Clean and format clean directory folder name
 */
function cleanFolderName(title) {
    let clean = (title || 'Nintendo_Switch_Game')
        .replace(/^Download\s+/i, '')
        .replace(/\s*(?:NSP|XCI|NSZ|Full Game|\+ Update|Update|DLC|Homebrew Port|Homebrew|Port|v\d+[\.\d]*)\b/gi, '')
        .replace(/[^a-zA-Z0-9_\- ]/g, '')
        .trim()
        .replace(/\s+/g, '_');
    return clean || 'Nintendo_Switch_Game';
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
            let gameData = null;
            let scrapeError = null;
            for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                    gameData = await scrapeGame(item.nswpedia_url, { resolveMirrors: true });
                    break;
                } catch (err) {
                    scrapeError = err;
                    if (attempt < 3) {
                        console.log(`⚠️ Scrape attempt ${attempt} failed: ${err.message}. Retrying in 5s...`);
                        await new Promise(r => setTimeout(r, 5000));
                    }
                }
            }
            if (!gameData) {
                throw scrapeError || new Error(`Failed to scrape game page after 3 attempts.`);
            }

            console.log(`\n📋 Extracted Game Details:`);
            console.log(`    Title:     ${gameData.title}`);
            console.log(`    Title ID:  ${gameData.titleId || 'N/A'}`);
            console.log(`    Firmware:  ${gameData.requiredFirmware || 'N/A'}`);
            console.log(`    Cover:     ${gameData.cover ? 'Found' : 'None'}`);
            console.log(`    Screens:   ${gameData.screenshots.length} screenshot(s) found`);
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

                const finalZipName = generateRomFilename(gameData.title, fileItem, '.zip');
                const subFolder = fileItem.type === 'Base Game' ? 'Base_Game' : (fileItem.type === 'Update' ? 'Updates' : 'DLC');
                const targetHamrahiFolder = `${gameFolderName}/${subFolder}`;

                try {
                    console.log(`    🔑 Refreshing AbreHamrahi access token...`);
                    const currentAccessToken = await getAccessToken(REFRESH_TOKEN);

                    console.log(`    ☁️ Resolving AbreHamrahi folder: "${targetHamrahiFolder}"...`);
                    const folderId = await resolveFolderPath(currentAccessToken, targetHamrahiFolder, REFRESH_TOKEN);

                    // Candidate filenames to check in AbreHamrahi before downloading
                    const candidateNames = [
                        finalZipName,
                        fileItem.name,
                        finalZipName.replace(/\.zip$/i, '.nsp'),
                        finalZipName.replace(/\.zip$/i, '.xci'),
                        fileItem.name.replace(/\.[a-zA-Z0-9]+$/, '') + '.zip',
                        `${cleanFolderName(gameData.title)}_${subFolder}.zip`,
                        `${cleanFolderName(gameData.title)}.zip`
                    ];

                    // Check if file already exists in AbreHamrahi
                    console.log(`    🔍 Checking if file already exists on AbreHamrahi Cloud...`);
                    let uploadResult = await findExistingFileInHamrahi(currentAccessToken, folderId, candidateNames, REFRESH_TOKEN);

                    if (!uploadResult) {
                        console.log(`    📥 File not found in cloud. Starting download from source: ${fileItem.directUrl}`);
                        // Step A: Determine clean temp filename
                        const tempExt = fileItem.format ? `.${fileItem.format.toLowerCase()}` : '.nsp';
                        const tempDownloadName = `temp_${Date.now()}_${cleanFolderName(gameData.title)}_${i + 1}${tempExt}`;
                        const tempLocalFilePath = path.join(DEST_DIR, tempDownloadName);

                        // Step B: Download file locally
                        console.log(`    Saving temporary download to: ${tempLocalFilePath}`);
                        const dlResult = await downloadRomFile(fileItem.directUrl, tempLocalFilePath);
                        console.log(`\n    ✅ Downloaded successfully: ${formatBytes(dlResult.totalBytes)}`);

                        // Step C: Package & encrypt into password-protected zip file
                        const protectedZipPath = path.join(DEST_DIR, finalZipName);
                        console.log(`    🔒 Packaging into protected Zip with password '${ZIP_PASSWORD}' -> ${finalZipName}...`);
                        createProtectedZip(tempLocalFilePath, protectedZipPath, ZIP_PASSWORD);
                        const zipStats = fs.statSync(protectedZipPath);
                        console.log(`    ✅ Protected Zip ready: ${formatBytes(zipStats.size)}`);

                        // Step D: Upload to AbreHamrahi Cloud
                        console.log(`    ☁️ Uploading to AbreHamrahi (${finalZipName})...`);
                        uploadResult = await uploadFileToHamrahi(currentAccessToken, protectedZipPath, folderId, finalZipName, REFRESH_TOKEN);
                        console.log(`    🎉 Upload Complete! Public Link: ${uploadResult.public_url}`);

                        // Step E: Clean up temporary local files
                        if (fs.existsSync(tempLocalFilePath)) {
                            fs.unlinkSync(tempLocalFilePath);
                        }
                        if (fs.existsSync(protectedZipPath)) {
                            fs.unlinkSync(protectedZipPath);
                            console.log(`    🧹 Cleaned up temporary local files: ${finalZipName}`);
                        }
                    } else {
                        console.log(`    ⚡ [CACHE HIT] Reusing existing cloud file without re-downloading: ${uploadResult.public_url}`);
                    }

                    // Step F: Record file metadata
                    let fileTypeKey = 'base_game';
                    if (fileItem.type === 'Update') fileTypeKey = 'update';
                    else if (fileItem.type === 'DLC') fileTypeKey = 'dlc';

                    let displayTitle = `${cleanGameTitle(gameData.title).replace(/_/g, ' ')}`;
                    if (fileItem.type === 'Base Game') {
                        displayTitle += ' - نسخه اصلی بازی';
                    } else if (fileItem.type === 'Update') {
                        displayTitle += ` - آپدیت ${fileItem.version || ''}`.trim();
                    } else if (fileItem.type === 'DLC') {
                        displayTitle += ' - بسته الحاقی (DLC)';
                    }

                    uploadedFiles.push({
                        file_type: fileTypeKey,
                        title: finalZipName,
                        display_title: displayTitle,
                        version: fileItem.version || 'v1.0.0',
                        file_size: formatBytes(uploadResult.size),
                        file_format: 'ZIP',
                        password: ZIP_PASSWORD,
                        part_number: 1,
                        total_parts: 1,
                        server_name: 'سرور اختصاصی مستقیم ابر همراهی (نیم‌بها)',
                        download_url: uploadResult.public_url,
                        folder_path: targetHamrahiFolder,
                        hamrahi_id: uploadResult.id,
                    });

                } catch (fileErr) {
                    console.error(`\n    ⚠️ Warning: Failed processing file ${fileItem.name}: ${fileErr.message}`);
                }
            }

            if (uploadedFiles.length === 0) {
                throw new Error('No files were successfully processed or uploaded for this game.');
            }

            // 5. Complete task in Website API
            console.log(`\n📤 Sending ${uploadedFiles.length} download links and metadata back to website API...`);
            const completePayload = {
                queue_id: item.id,
                game_title: gameData.title,
                title_id: gameData.titleId || null,
                scraped_data: {
                    title: gameData.title,
                    title_id: gameData.titleId || null,
                    required_firmware: gameData.requiredFirmware || null,
                    developer: gameData.developer || gameData.publisher || 'Nintendo',
                    publisher: gameData.publisher || 'Nintendo',
                    release_date: gameData.releaseDate || null,
                    format: gameData.format || 'NSP',
                    cover_image: gameData.cover_image || gameData.cover || null,
                    banner_image: gameData.banner_image || gameData.banner || null,
                    screenshots: gameData.screenshots || [],
                    summary: gameData.description ? gameData.description.substring(0, 300) : '',
                    description: gameData.description || '',
                    genres: gameData.genres || ['Arcade', 'Action'],
                },
                uploaded_files: uploadedFiles,
            };

            if (item.id > 0) {
                const completeRes = await apiRequest('/api/v1/games/queue/complete', 'POST', completePayload);
                console.log(`✅ API response: ${completeRes.message || 'Complete!'}`);
            }

            console.log(`\n🎉 Queue Item #${item.id} (${gameData.title}) completed successfully with ${uploadedFiles.length} file(s)!`);

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
