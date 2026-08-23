#!/usr/bin/env node

/**
 * NSWPedia Direct Download Links Scraper & Downloader
 * 
 * Features:
 *  - Search ROMs by keyword on NSWPedia
 *  - Extract complete metadata (Title, Cover, Screenshots, Description)
 *  - Extract all mirrors (Base Game, Updates, DLCs)
 *  - Follow intermediate download pages to get direct storage links (Vikingfile/Direct, 1Fichier, Datanodes)
 *  - High-speed direct file downloading with live progress bar, speed, and resume support
 *  - Modular (exportable to other scripts) and CLI executable
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

/**
 * HTTP GET helper with redirect handling, custom headers and auto-retry
 */
function fetchUrl(urlStr, options = {}, retries = 3) {
    return new Promise((resolve, reject) => {
        let parsedUrl;
        try {
            parsedUrl = new URL(urlStr);
        } catch (e) {
            return reject(new Error(`Invalid URL: ${urlStr}`));
        }

        const protocol = parsedUrl.protocol === 'https:' ? https : http;

        const reqOptions = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
            path: parsedUrl.pathname + parsedUrl.search,
            method: 'GET',
            headers: {
                'User-Agent': USER_AGENT,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Referer': options.referer || 'https://nswpedia.com/',
                ...options.headers
            },
            rejectUnauthorized: false
        };

        const req = protocol.request(reqOptions, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                const nextUrl = new URL(res.headers.location, urlStr).href;
                return resolve(fetchUrl(nextUrl, { ...options, referer: urlStr }, retries));
            }

            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                resolve({
                    status: res.statusCode,
                    headers: res.headers,
                    body: data,
                    finalUrl: urlStr
                });
            });
        });

        req.on('error', (err) => {
            if (retries > 0) {
                setTimeout(() => {
                    resolve(fetchUrl(urlStr, options, retries - 1));
                }, 1500);
            } else {
                reject(err);
            }
        });

        req.setTimeout(options.timeout || 30000, () => {
            req.destroy(new Error(`Timeout fetching ${urlStr}`));
        });

        req.end();
    });
}

/**
 * Strip HTML tags and decode entities
 */
function stripHtml(html) {
    if (!html) return '';
    return html
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#039;/g, "'")
        .replace(/&rsquo;/g, "'")
        .replace(/&lsquo;/g, "'")
        .replace(/&ldquo;/g, '"')
        .replace(/&rdquo;/g, '"')
        .replace(/&#8217;/g, "'")
        .replace(/&#8216;/g, "'")
        .replace(/&#8220;/g, '"')
        .replace(/&#8221;/g, '"')
        .replace(/&#8211;/g, '-')
        .replace(/&#8212;/g, '--')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Format bytes to human readable format
 */
function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Clean filename string for safe storage on disk
 */
function sanitizeFilename(name) {
    return (name || 'rom').replace(/[<>:"/\\|?*#]/g, '_').trim();
}

/**
 * Parse ROM details (Type, Version, Format) from item title
 */
function parseRomItemDetails(title, formatHint = '') {
    const raw = (title || '').trim();
    let type = 'Base Game';
    let version = 'v1.0.0';
    let format = (formatHint || '').toUpperCase().trim();

    if (/\.xci/i.test(raw) || /\[XCI\]/i.test(raw) || format === 'XCI') {
        format = 'XCI';
    } else if (/\.nsz/i.test(raw) || /\[NSZ\]/i.test(raw) || format === 'NSZ') {
        format = 'NSZ';
    } else if (/\.7z/i.test(raw) || format === '7Z') {
        format = '7Z';
    } else if (/\.zip/i.test(raw) || format === 'ZIP') {
        format = 'ZIP';
    } else if (/\.rar/i.test(raw) || format === 'RAR') {
        format = 'RAR';
    } else if (!format) {
        format = 'NSP';
    }

    if (/update/i.test(raw) || /v\d+(\.\d+)+/i.test(raw) || /\[v\d+\]/i.test(raw)) {
        type = 'Update';
        const vMatch = raw.match(/v(\d+(\.\d+)*)/i) || raw.match(/\[v(\d+)\]/i);
        if (vMatch) {
            version = vMatch[0].startsWith('v') ? vMatch[0] : `v${vMatch[1]}`;
        } else {
            version = 'Update';
        }
    } else if (/dlc/i.test(raw) || /pack/i.test(raw) || /expansion/i.test(raw) || /unlocker/i.test(raw)) {
        type = 'DLC';
        version = 'DLC';
    } else if (/base/i.test(raw) || /main/i.test(raw)) {
        type = 'Base Game';
        version = 'v1.0.0';
    }

    return { raw, type, version, format };
}

/**
 * Search NSWPedia for games matching query
 */
async function searchGames(query, limit = 10) {
    const searchUrl = `https://nswpedia.com/?s=${encodeURIComponent(query)}`;
    const response = await fetchUrl(searchUrl);
    const html = response.body;

    const results = [];
    const itemRegex = /<div class="archive-left subtitle">([\s\S]*?)<\/div>\s*<\/div>/gi;
    let match;

    while ((match = itemRegex.exec(html)) !== null && results.length < limit) {
        const block = match[1];

        const linkMatch = block.match(/href=['"](https:\/\/nswpedia\.com\/nintendo-switch-roms\/[^'"]+)['"][^>]*>([\s\S]*?)<\/a>/i);
        if (!linkMatch) continue;

        const url = linkMatch[1];
        const rawTitle = stripHtml(linkMatch[2]);

        const imgMatch = block.match(/<img[^>]+src=['"]([^'"]+)['"]/i);
        const cover = imgMatch ? imgMatch[1] : null;

        const badges = [];
        const badgeRegex = /<span class="badge[^"]*">([^<]+)<\/span>/gi;
        let bMatch;
        while ((bMatch = badgeRegex.exec(block)) !== null) {
            badges.push(stripHtml(bMatch[1]));
        }

        results.push({
            title: rawTitle,
            url,
            cover,
            badges
        });
    }

    return results;
}

/**
 * Fetch latest ROMs from category page
 */
async function getLatestGames(page = 1, limit = 12) {
    const catUrl = page > 1 
        ? `https://nswpedia.com/category/nintendo-switch-roms/page/${page}/`
        : `https://nswpedia.com/category/nintendo-switch-roms/`;

    const response = await fetchUrl(catUrl);
    const html = response.body;

    const results = [];
    const itemRegex = /<div class="archive-left subtitle">([\s\S]*?)<\/div>\s*<\/div>/gi;
    let match;

    while ((match = itemRegex.exec(html)) !== null && results.length < limit) {
        const block = match[1];

        const linkMatch = block.match(/href=['"](https:\/\/nswpedia\.com\/nintendo-switch-roms\/[^'"]+)['"][^>]*>([\s\S]*?)<\/a>/i);
        if (!linkMatch) continue;

        const url = linkMatch[1];
        const rawTitle = stripHtml(linkMatch[2]);

        const imgMatch = block.match(/<img[^>]+src=['"]([^'"]+)['"]/i);
        const cover = imgMatch ? imgMatch[1] : null;

        const badges = [];
        const badgeRegex = /<span class="badge[^"]*">([^<]+)<\/span>/gi;
        let bMatch;
        while ((bMatch = badgeRegex.exec(block)) !== null) {
            badges.push(stripHtml(bMatch[1]));
        }

        results.push({
            title: rawTitle,
            url,
            cover,
            badges
        });
    }

    return results;
}

/**
 * Resolve direct download storage link from intermediate NSWPedia download URL
 */
async function resolveDirectDownloadLink(downloadListUrl) {
    try {
        const res = await fetchUrl(downloadListUrl);
        const html = res.body;

        const match = html.match(/<a[^>]+id=['"]download-link['"][^>]+href=['"]([^'"]+)['"]/i) ||
                      html.match(/id=['"]download-link['"][^>]*\s+href=['"]([^'"]+)['"]/i) ||
                      html.match(/href=['"]([^'"]+)['"][^>]*id=['"]download-link['"]/i);

        if (match) {
            return match[1].replace(/&amp;/g, '&');
        }

        const directMatch = html.match(/href=['"](https?:\/\/(?:vikingfile|1fichier|datanodes|multiup|rushupload|mediafire|mega|drive\.google)[^'"]+)['"]/i);
        if (directMatch) {
            return directMatch[1].replace(/&amp;/g, '&');
        }

        return null;
    } catch (err) {
        return null;
    }
}

/**
 * Scrape complete game page, including all metadata and direct download mirrors
 */
async function scrapeGame(gameUrl, options = { resolveMirrors: true, concurrency: 5 }) {
    const res = await fetchUrl(gameUrl);
    const html = res.body;

    // 1. Title
    const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    const title = h1Match ? stripHtml(h1Match[1]) : '';

    // 2. Cover & Screenshots
    const coverMatch = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i) ||
                       html.match(/<img[^>]+class="[^"]*attachment-post-thumbnail[^"]*"[^>]+src="([^"]+)"/i);
    const cover = coverMatch ? coverMatch[1] : null;

    const screenshots = [];
    const ssRegex = /<a[^>]+class="[^"]*screen_shot[^"]*"[^>]+href="([^"]+)"/gi;
    let sMatch;
    while ((sMatch = ssRegex.exec(html)) !== null) {
        if (!screenshots.includes(sMatch[1])) {
            screenshots.push(sMatch[1]);
        }
    }

    // 3. Game description
    let description = '';
    const descMatch = html.match(/<h3>Game description<\/h3>([\s\S]*?)(?:<div class="my-3"|<a [^>]*class="btn|<center>)/i);
    if (descMatch) {
        description = stripHtml(descMatch[1]);
    }

    // 4. Download main page link
    const dlBtnMatch = html.match(/<a[^>]+href=['"](https:\/\/nswpedia\.com\/download\/[^'"]+)['"][^>]*>/i);
    if (!dlBtnMatch) {
        return {
            title,
            gameUrl,
            cover,
            screenshots,
            description,
            downloadPageUrl: null,
            mirrors: [],
            downloads: []
        };
    }

    const downloadPageUrl = dlBtnMatch[1];

    // 5. Fetch Download Page
    const dlRes = await fetchUrl(downloadPageUrl, { referer: gameUrl });
    const dlHtml = dlRes.body;

    // 6. Parse all download tables
    const mirrorTables = [];
    const tableDivRegex = /<div[^>]*class=['"][^'"]*table-download[^'"]*['"][^>]*>([\s\S]*?)<\/div>/gi;
    let tMatch;
    let tableIndex = 0;

    while ((tMatch = tableDivRegex.exec(dlHtml)) !== null) {
        tableIndex++;
        const block = tMatch[1];

        // Find server heading
        const insideHMatch = block.match(/<h[234][^>]*>([\s\S]*?)<\/h[234]>/i);
        let serverName = insideHMatch ? stripHtml(insideHMatch[1]) : '';

        if (!serverName) {
            const preHtml = dlHtml.substring(0, tMatch.index);
            const outsideHMatch = preHtml.match(/<h[234][^>]*>([\s\S]*?)<\/h[234]>(?:(?!<h[234])[\s\S])*$/i);
            serverName = outsideHMatch ? stripHtml(outsideHMatch[1]) : `Mirror Group ${tableIndex}`;
        }

        serverName = serverName.replace(/^Downloads List\s*[-–:]*\s*/i, '').trim() || `Mirror Group ${tableIndex}`;

        // Parse rows
        const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
        let rMatch;
        const items = [];

        while ((rMatch = rowRegex.exec(block)) !== null) {
            const rowContent = rMatch[1];
            if (rowContent.includes('<th')) continue;

            const colRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
            const cols = [];
            let cMatch;
            while ((cMatch = colRegex.exec(rowContent)) !== null) {
                cols.push(stripHtml(cMatch[1]));
            }

            const linkMatch = rowContent.match(/href=['"](https:\/\/nswpedia\.com\/download\/[^'"]+)['"]/i);
            const intermediateUrl = linkMatch ? linkMatch[1] : null;

            if (cols.length > 0 && intermediateUrl) {
                const itemName = cols[0] || '';
                let col1 = cols[1] || '';
                let col2 = cols[2] || '';

                let size = col1;
                let typeHint = col2;

                // Smart detection: if col1 is a format extension and col2 is a byte size
                if (/^(zip|nsp|xci|nsz|rar|7z)$/i.test(col1.trim()) || /\b(KB|MB|GB|TB|B)\b/i.test(col2)) {
                    size = col2;
                    typeHint = col1;
                } else if (/\b(KB|MB|GB|TB|B)\b/i.test(col1)) {
                    size = col1;
                    typeHint = col2;
                }

                const details = parseRomItemDetails(itemName, typeHint);

                items.push({
                    name: itemName,
                    size,
                    format: details.format,
                    type: details.type,
                    version: details.version,
                    intermediateUrl,
                    directUrl: null
                });
            }
        }

        if (items.length > 0) {
            mirrorTables.push({
                serverName,
                items
            });
        }
    }

    // 7. Resolve Direct Download Links
    if (options.resolveMirrors) {
        const allItems = [];
        for (const table of mirrorTables) {
            for (const item of table.items) {
                allItems.push(item);
            }
        }

        const batchSize = options.concurrency || 5;
        for (let i = 0; i < allItems.length; i += batchSize) {
            const batch = allItems.slice(i, i + batchSize);
            await Promise.all(batch.map(async (item) => {
                if (item.intermediateUrl) {
                    item.directUrl = await resolveDirectDownloadLink(item.intermediateUrl);
                }
            }));
        }
    }

    // Flatten all downloads
    const allDownloads = [];
    for (const table of mirrorTables) {
        for (const item of table.items) {
            allDownloads.push({
                server: table.serverName,
                name: item.name,
                type: item.type,
                version: item.version,
                size: item.size,
                format: item.format,
                intermediateUrl: item.intermediateUrl,
                directUrl: item.directUrl
            });
        }
    }

    return {
        title,
        gameUrl,
        downloadPageUrl,
        cover,
        screenshots,
        description,
        mirrors: mirrorTables,
        downloads: allDownloads
    };
}

/**
 * Download a file from URL with resume support, auto redirects, and progress callback
 */
function downloadFile(urlStr, destPath, options = {}) {
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(urlStr);
        const protocol = parsedUrl.protocol === 'https:' ? https : http;

        let existingBytes = 0;
        if (fs.existsSync(destPath)) {
            existingBytes = fs.statSync(destPath).size;
        }

        const headers = {
            'User-Agent': USER_AGENT,
            'Accept': '*/*',
            'Referer': options.referer || 'https://nswpedia.com/'
        };

        if (existingBytes > 0 && options.resume !== false) {
            headers['Range'] = `bytes=${existingBytes}-`;
        }

        const reqOptions = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
            path: parsedUrl.pathname + parsedUrl.search,
            method: 'GET',
            headers,
            rejectUnauthorized: false
        };

        const startTime = Date.now();
        let lastSpeedCheck = startTime;
        let bytesSinceLastCheck = 0;
        let currentSpeed = 0;

        const req = protocol.request(reqOptions, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                const nextUrl = new URL(res.headers.location, urlStr).href;
                return resolve(downloadFile(nextUrl, destPath, { ...options, referer: urlStr }));
            }

            if (res.statusCode === 416) {
                return resolve({
                    destPath,
                    totalBytes: existingBytes,
                    alreadyDownloaded: true
                });
            }

            if (res.statusCode !== 200 && res.statusCode !== 206) {
                return reject(new Error(`Download failed with HTTP ${res.statusCode}: ${res.statusMessage}`));
            }

            let finalFilename = null;
            const disp = res.headers['content-disposition'];
            if (disp) {
                const fnMatch = disp.match(/filename\*?=(?:UTF-8'')?["']?([^"';]+)["']?/i);
                if (fnMatch) {
                    finalFilename = decodeURIComponent(fnMatch[1].replace(/['"]/g, '').trim());
                }
            }

            const contentLength = parseInt(res.headers['content-length'] || '0', 10);
            const totalBytes = res.statusCode === 206 ? (existingBytes + contentLength) : contentLength;

            const fileStream = fs.createWriteStream(destPath, {
                flags: res.statusCode === 206 ? 'a' : 'w'
            });

            let downloadedBytes = res.statusCode === 206 ? existingBytes : 0;

            res.on('data', chunk => {
                downloadedBytes += chunk.length;
                bytesSinceLastCheck += chunk.length;
                fileStream.write(chunk);

                const now = Date.now();
                if (now - lastSpeedCheck >= 500) {
                    currentSpeed = bytesSinceLastCheck / ((now - lastSpeedCheck) / 1000);
                    lastSpeedCheck = now;
                    bytesSinceLastCheck = 0;
                }

                if (options.onProgress) {
                    options.onProgress({
                        downloadedBytes,
                        totalBytes,
                        speedBytesPerSec: currentSpeed,
                        percentage: totalBytes > 0 ? (downloadedBytes / totalBytes) * 100 : 0
                    });
                }
            });

            res.on('end', () => {
                fileStream.end();
                resolve({
                    destPath,
                    finalFilename,
                    totalBytes: downloadedBytes
                });
            });

            res.on('error', err => {
                fileStream.end();
                reject(err);
            });
        });

        req.on('error', reject);
        req.end();
    });
}

// Module Exports
module.exports = {
    searchGames,
    getLatestGames,
    scrapeGame,
    downloadFile,
    resolveDirectDownloadLink,
    parseRomItemDetails,
    formatBytes,
    sanitizeFilename
};

// ==========================================
// CLI Execution
// ==========================================
if (require.main === module) {
    (async () => {
        const args = process.argv.slice(2);

        if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
            console.log(`
╔══════════════════════════════════════════════════════════════════════╗
║               NSWPedia ROM Scraper & File Downloader                 ║
╚══════════════════════════════════════════════════════════════════════╝

Usage:
  node scripts/nswpedia_scraper.cjs <URL or Game Name> [options]

Commands & Options:
  # 1. Scrape and extract direct download links:
  node scripts/nswpedia_scraper.cjs "https://nswpedia.com/nintendo-switch-roms/action/pokemon-lets-go-pikachu-nsp-34"

  # 2. Scrape AND Download files to disk:
  node scripts/nswpedia_scraper.cjs "Pokemon Let's Go Pikachu" --download all
  node scripts/nswpedia_scraper.cjs "Pokemon Let's Go Pikachu" --download update
  node scripts/nswpedia_scraper.cjs "Pokemon Let's Go Pikachu" --download base
  node scripts/nswpedia_scraper.cjs "Pokemon Let's Go Pikachu" --download dlc

  # 3. Specify custom destination folder:
  node scripts/nswpedia_scraper.cjs "Zelda Tears of the Kingdom" --download update --dest ./roms/

  # 4. Search games:
  node scripts/nswpedia_scraper.cjs --search "Mario Kart"

  # 5. List latest ROMs:
  node scripts/nswpedia_scraper.cjs --latest --limit 5

  # 6. JSON output or export:
  node scripts/nswpedia_scraper.cjs "Super Mario Odyssey" --json
  node scripts/nswpedia_scraper.cjs "Mario Kart 8" --output mk8.json

Download Filters:
  --download [all|base|update|dlc]   Download matching files
  --dest <directory>                Destination folder (default: ./downloads)
  --output <file>                   Save scraped data into a JSON file
  --no-resolve                      Do not resolve direct links
  -h, --help                        Show this help
`);
            process.exit(0);
        }

        const isJson = args.includes('--json');
        const noResolve = args.includes('--no-resolve');
        const outputIdx = args.indexOf('--output');
        const outputFile = outputIdx !== -1 ? args[outputIdx + 1] : null;

        const limitIdx = args.indexOf('--limit');
        const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : 10;

        const downloadIdx = args.indexOf('--download');
        const isDownloading = downloadIdx !== -1;
        const downloadFilter = isDownloading ? (args[downloadIdx + 1] && !args[downloadIdx + 1].startsWith('-') ? args[downloadIdx + 1].toLowerCase() : 'all') : null;

        const destIdx = args.indexOf('--dest');
        const destDir = destIdx !== -1 ? args[destIdx + 1] : path.join(process.cwd(), 'downloads');

        try {
            if (args.includes('--latest')) {
                if (!isJson) console.log(`🔍 Fetching latest ROMs from NSWPedia...`);
                const latest = await getLatestGames(1, limit);
                if (isJson) {
                    console.log(JSON.stringify(latest, null, 2));
                } else {
                    console.log(`\nFound ${latest.length} ROMs:`);
                    latest.forEach((g, i) => {
                        console.log(`\n[${i + 1}] ${g.title}`);
                        console.log(`    URL: ${g.url}`);
                        if (g.badges.length) console.log(`    Tags: ${g.badges.join(', ')}`);
                    });
                }
                process.exit(0);
            }

            const searchIdx = args.indexOf('--search');
            if (searchIdx !== -1) {
                const query = args[searchIdx + 1];
                if (!query) {
                    console.error('Error: Please provide a search query.');
                    process.exit(1);
                }
                if (!isJson) console.log(`🔍 Searching NSWPedia for: "${query}"...`);
                const searchResults = await searchGames(query, limit);

                if (isJson) {
                    console.log(JSON.stringify(searchResults, null, 2));
                } else {
                    console.log(`\nFound ${searchResults.length} results:`);
                    searchResults.forEach((g, i) => {
                        console.log(`\n[${i + 1}] ${g.title}`);
                        console.log(`    URL: ${g.url}`);
                        if (g.badges.length) console.log(`    Tags: ${g.badges.join(', ')}`);
                    });

                    if (searchResults.length > 0) {
                        console.log(`\n💡 To scrape or download:`);
                        console.log(`node scripts/nswpedia_scraper.cjs "${searchResults[0].url}" --download all`);
                    }
                }
                process.exit(0);
            }

            // Target URL or query
            let targetUrl = args.find(a => a.startsWith('http://') || a.startsWith('https://'));

            if (!targetUrl) {
                const query = args.filter(a => !a.startsWith('-') && a !== downloadFilter && a !== outputFile && a !== destDir).join(' ');
                if (!isJson) console.log(`🔍 Searching NSWPedia for: "${query}"...`);
                const results = await searchGames(query, 1);
                if (results.length === 0) {
                    console.error(`No game found matching "${query}".`);
                    process.exit(1);
                }
                targetUrl = results[0].url;
                if (!isJson) console.log(`👉 Selected: ${results[0].title} (${targetUrl})\n`);
            }

            if (!isJson) console.log(`🚀 Scraping game from: ${targetUrl}`);
            const gameData = await scrapeGame(targetUrl, { resolveMirrors: true, concurrency: 4 });

            if (isJson && !isDownloading) {
                console.log(JSON.stringify(gameData, null, 2));
            } else {
                console.log(`\n===============================================================`);
                console.log(`🎮 Game: ${gameData.title}`);
                console.log(`🔗 Page: ${gameData.gameUrl}`);
                console.log(`📥 Download Page: ${gameData.downloadPageUrl || 'N/A'}`);
                if (gameData.cover) console.log(`🖼️  Cover: ${gameData.cover}`);
                console.log(`===============================================================\n`);

                gameData.mirrors.forEach((m, mIdx) => {
                    console.log(`\n📦 [Mirror Group ${mIdx + 1}] ${m.serverName}`);
                    console.log(`---------------------------------------------------------------`);
                    m.items.forEach(item => {
                        console.log(`  🔹 ${item.name}`);
                        console.log(`     Type: ${item.type} | Version: ${item.version} | Size: ${item.size} | Format: ${item.format}`);
                        if (item.directUrl) {
                            console.log(`     ⚡ DIRECT LINK: \x1b[32m${item.directUrl}\x1b[0m`);
                        } else {
                            console.log(`     🔗 Intermediary: ${item.intermediateUrl}`);
                        }
                    });
                });
                console.log(`\n===============================================================\n`);
            }

            if (outputFile) {
                fs.writeFileSync(outputFile, JSON.stringify(gameData, null, 2), 'utf-8');
                if (!isJson) console.log(`💾 Saved output to: ${outputFile}\n`);
            }

            // ==========================================
            // Perform File Downloads if requested
            // ==========================================
            if (isDownloading) {
                if (!fs.existsSync(destDir)) {
                    fs.mkdirSync(destDir, { recursive: true });
                }

                let candidateDownloads = gameData.downloads.filter(d => d.directUrl && (d.directUrl.includes('vikingfile.com') || d.directUrl.includes('storage') || d.directUrl.includes('http')));

                if (downloadFilter === 'base') {
                    candidateDownloads = candidateDownloads.filter(d => d.type === 'Base Game');
                } else if (downloadFilter === 'update') {
                    candidateDownloads = candidateDownloads.filter(d => d.type === 'Update');
                } else if (downloadFilter === 'dlc') {
                    candidateDownloads = candidateDownloads.filter(d => d.type === 'DLC');
                }

                const uniqueDownloads = [];
                const seenKeys = new Set();

                candidateDownloads.sort((a, b) => {
                    if (a.directUrl.includes('vikingfile.com')) return -1;
                    if (b.directUrl.includes('vikingfile.com')) return 1;
                    return 0;
                });

                for (const item of candidateDownloads) {
                    const key = `${item.type}_${item.version}_${item.name.toLowerCase()}`;
                    if (!seenKeys.has(key)) {
                        seenKeys.add(key);
                        uniqueDownloads.push(item);
                    }
                }

                if (uniqueDownloads.length === 0) {
                    console.log(`⚠️ No downloadable direct links found for filter: "${downloadFilter}".`);
                    process.exit(0);
                }

                console.log(`\n⬇️  Starting download of ${uniqueDownloads.length} file(s) into: ${destDir}\n`);

                for (let i = 0; i < uniqueDownloads.length; i++) {
                    const item = uniqueDownloads[i];
                    
                    let fileExt = item.format ? `.${item.format.toLowerCase()}` : '.nsp';
                    let safeName = sanitizeFilename(item.name);
                    if (!safeName.endsWith(fileExt)) {
                        safeName += fileExt;
                    }

                    const targetFile = path.join(destDir, safeName);

                    console.log(`\n[${i + 1}/${uniqueDownloads.length}] 📥 Downloading: ${item.name} (${item.size})`);
                    console.log(`    Save As: ${targetFile}`);
                    console.log(`    Source:  ${item.directUrl}`);

                    let lastRender = 0;
                    try {
                        const result = await downloadFile(item.directUrl, targetFile, {
                            onProgress: (prog) => {
                                const now = Date.now();
                                if (now - lastRender >= 250 || prog.percentage === 100) {
                                    lastRender = now;
                                    const pct = prog.percentage.toFixed(1);
                                    const downStr = formatBytes(prog.downloadedBytes);
                                    const totalStr = formatBytes(prog.totalBytes);
                                    const speedStr = formatBytes(prog.speedBytesPerSec) + '/s';

                                    const barWidth = 25;
                                    const filled = Math.round((barWidth * prog.percentage) / 100);
                                    const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled);

                                    process.stdout.write(`\r    [${bar}] ${pct}% | ${downStr}/${totalStr} | ⚡ ${speedStr}   `);
                                }
                            }
                        });

                        console.log(`\n    ✅ Download Complete: ${safeName} (${formatBytes(result.totalBytes)})\n`);
                    } catch (dlErr) {
                        console.error(`\n    ❌ Download failed for ${item.name}: ${dlErr.message}`);
                    }
                }

                console.log(`\n🎉 All requested downloads completed!\n`);
            }

        } catch (err) {
            console.error('❌ Error during execution:', err.message);
            process.exit(1);
        }
    })();
}
