#!/usr/bin/env node

/**
 * AbreHamrahi Automated Uploader with Folder Hierarchy Support
 * Developed for Ninten2 Switch ROM Distribution System
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const CHUNK_SIZE = 5242880; // 5MB standard chunk size for AbreHamrahi

function request(options, data = null, retries = 3) {
    return new Promise((resolve, reject) => {
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
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
            ...options.headers
        };

        if (payload) {
            headers['Content-Length'] = payload.length;
        }

        const req = https.request({
            ...options,
            headers
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
        req.on('error', (err) => {
            if (retries > 0) {
                setTimeout(() => {
                    resolve(request(options, data, retries - 1));
                }, 1500);
            } else {
                reject(err);
            }
        });
        if (payload) {
            req.write(payload);
        }
        req.end();
    });
}

function putChunk(urlStr, buffer, retries = 3) {
    return new Promise((resolve, reject) => {
        const url = new URL(urlStr);
        const req = https.request({
            hostname: url.hostname,
            port: url.port || 443,
            path: url.pathname + url.search,
            method: 'PUT',
            headers: {
                'Content-Length': buffer.length
            }
        }, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    resolve({
                        status: res.statusCode,
                        etag: res.headers.etag ? res.headers.etag.replace(/"/g, '') : ''
                    });
                } else if (retries > 0) {
                    console.log(`\n⚠️ Chunk failed with status ${res.statusCode}. Retrying (${retries} left)...`);
                    setTimeout(() => resolve(putChunk(urlStr, buffer, retries - 1)), 2000);
                } else {
                    reject(new Error(`Failed to upload chunk: HTTP ${res.statusCode}`));
                }
            });
        });
        req.on('error', (err) => {
            if (retries > 0) {
                console.log(`\n⚠️ Network error: ${err.message}. Retrying (${retries} left)...`);
                setTimeout(() => resolve(putChunk(urlStr, buffer, retries - 1)), 2000);
            } else {
                reject(err);
            }
        });
        req.write(buffer);
        req.end();
    });
}

async function getAccessToken(tokenInput) {
    if (!tokenInput) {
        throw new Error('Missing token input in getAccessToken');
    }

    let refreshToken = tokenInput;

    // Check if user passed the full JSON response or quoted string
    if (typeof tokenInput === 'string') {
        let cleaned = tokenInput.trim();
        if ((cleaned.startsWith("'") && cleaned.endsWith("'")) || (cleaned.startsWith('"') && cleaned.endsWith('"'))) {
            cleaned = cleaned.slice(1, -1).trim();
        }
        if (cleaned.startsWith('{') && cleaned.endsWith('}')) {
            try {
                const parsed = JSON.parse(cleaned);
                if (parsed.refresh) {
                    refreshToken = parsed.refresh;
                } else if (parsed.access) {
                    refreshToken = parsed.access;
                }
            } catch (e) {}
        } else {
            refreshToken = cleaned;
        }
    } else if (typeof tokenInput === 'object' && tokenInput !== null && tokenInput.refresh) {
        refreshToken = tokenInput.refresh;
    }

    const res = await request({
        hostname: 'abrehamrahi.ir',
        path: '/api/v2/profile/auth/token-refresh/',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
    }, { refresh: refreshToken });

    if (res.status !== 200 || !res.body.access) {
        throw new Error(`Token refresh failed (HTTP ${res.status}): ${JSON.stringify(res.body)}`);
    }

    return res.body.access;
}

/**
 * Resolve or create folder hierarchy recursively (e.g. "Nintendo_Switch/Zelda_TotK/Updates")
 */
async function resolveFolderPath(accessToken, folderPath, refreshToken = null) {
    if (!folderPath || folderPath === '/' || folderPath === '.') return null;

    const parts = folderPath.split('/').map(p => p.trim()).filter(Boolean);
    let currentParentId = null;
    let activeToken = accessToken;

    for (const folderName of parts) {
        // 1. List objects in current parent to check if folder already exists
        const listPath = currentParentId 
            ? `/api/v2/flat/list-objects/?parent=${currentParentId}` 
            : '/api/v2/flat/list-objects/';

        let listRes = await request({
            hostname: 'abrehamrahi.ir',
            path: listPath,
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${activeToken}`,
                'Accept': 'application/json'
            }
        });

        if ((listRes.status === 401 || (listRes.body && listRes.body.code === 'token_not_valid')) && refreshToken) {
            activeToken = await getAccessToken(refreshToken);
            listRes = await request({
                hostname: 'abrehamrahi.ir',
                path: listPath,
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${activeToken}`,
                    'Accept': 'application/json'
                }
            });
        }

        let existingFolder = null;
        if (listRes.status === 200 && Array.isArray(listRes.body.results)) {
            existingFolder = listRes.body.results.find(
                item => item.type === 'folder' && item.name.toLowerCase() === folderName.toLowerCase()
            );
        }

        if (existingFolder) {
            currentParentId = existingFolder.id;
        } else {
            // 2. Create new folder
            console.log(`📁 Creating folder "${folderName}" (Parent ID: ${currentParentId || 'Root'})...`);
            let createRes = await request({
                hostname: 'abrehamrahi.ir',
                path: '/api/v2/flat/create-folder/',
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${activeToken}`,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                }
            }, {
                name: folderName,
                parent: currentParentId
            });

            if ((createRes.status === 401 || (createRes.body && createRes.body.code === 'token_not_valid')) && refreshToken) {
                activeToken = await getAccessToken(refreshToken);
                createRes = await request({
                    hostname: 'abrehamrahi.ir',
                    path: '/api/v2/flat/create-folder/',
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${activeToken}`,
                        'Content-Type': 'application/json',
                        'Accept': 'application/json'
                    }
                }, {
                    name: folderName,
                    parent: currentParentId
                });
            }

            if (createRes.status === 200 || createRes.status === 201) {
                currentParentId = createRes.body.id;
            } else {
                throw new Error(`Failed to create folder "${folderName}": ${JSON.stringify(createRes.body)}`);
            }
        }
    }

    return currentParentId;
}

/**
 * Upload a local file to AbreHamrahi with progress indicator
 */
async function uploadFileToHamrahi(accessToken, filePath, parentFolderId = null, customFileName = null, refreshToken = null) {
    if (!fs.existsSync(filePath)) {
        throw new Error(`File not found at: ${filePath}`);
    }

    const stats = fs.statSync(filePath);
    const fileSize = stats.size;
    const fileName = customFileName || path.basename(filePath);

    console.log(`\n🚀 Uploading "${fileName}" (${(fileSize / (1024 * 1024)).toFixed(2)} MB)...`);

    let activeAccessToken = accessToken;

    const refreshActiveToken = async () => {
        if (refreshToken) {
            try {
                const refreshed = await getAccessToken(refreshToken);
                if (refreshed) {
                    activeAccessToken = refreshed;
                    return refreshed;
                }
            } catch (e) {
                console.warn(`⚠️ Token refresh failed: ${e.message}`);
            }
        }
        return activeAccessToken;
    };

    // 1. Start Upload
    let startRes = await request({
        hostname: 'abrehamrahi.ir',
        path: '/api/v2/flat/start-upload/',
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${activeAccessToken}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        }
    }, { obj_size: fileSize });

    if ((startRes.status === 401 || (startRes.body && startRes.body.code === 'token_not_valid')) && refreshToken) {
        console.log('🔄 Token expired before start-upload. Refreshing token...');
        await refreshActiveToken();
        startRes = await request({
            hostname: 'abrehamrahi.ir',
            path: '/api/v2/flat/start-upload/',
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${activeAccessToken}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            }
        }, { obj_size: fileSize });
    }

    if (startRes.status !== 200 && startRes.status !== 201) {
        throw new Error(`Start upload failed (HTTP ${startRes.status}): ${JSON.stringify(startRes.body)}`);
    }

    const { key, upload_id, signed_urls } = startRes.body;
    console.log(`📦 Allocated ${signed_urls.length} chunk(s) (5MB each).`);

    // 2. Upload Chunks
    const fd = fs.openSync(filePath, 'r');
    const completedParts = [];
    const buffer = Buffer.alloc(CHUNK_SIZE);

    for (let i = 0; i < signed_urls.length; i++) {
        const partNumber = i + 1;
        const partUrl = signed_urls[i];
        const bytesToRead = Math.min(CHUNK_SIZE, fileSize - (i * CHUNK_SIZE));
        
        fs.readSync(fd, buffer, 0, bytesToRead, i * CHUNK_SIZE);
        const chunkSlice = buffer.subarray(0, bytesToRead);

        const percent = ((partNumber / signed_urls.length) * 100).toFixed(1);
        process.stdout.write(`\r⏳ Uploading chunk ${partNumber}/${signed_urls.length} [${percent}%]...`);

        const result = await putChunk(partUrl, chunkSlice);

        completedParts.push({
            PartNumber: partNumber,
            ETag: `"${result.etag}"`,
            size: bytesToRead
        });
    }
    fs.closeSync(fd);
    console.log('\n✅ All chunks uploaded.');

    // 3. Complete Upload
    console.log('🔄 Finalizing upload with AbreHamrahi storage...');
    
    // Always refresh token before complete-upload if refreshToken is available, because uploading chunks for large files can take many minutes!
    if (refreshToken) {
        console.log('🔑 Refreshing access token before completing upload (protecting against expiration)...');
        await refreshActiveToken();
    }

    let completeRes = await request({
        hostname: 'abrehamrahi.ir',
        path: '/api/v2/flat/complete-upload/',
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${activeAccessToken}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        }
    }, {
        key: key,
        name: fileName,
        parent: parentFolderId,
        upload_id: upload_id,
        parts: completedParts,
        force_overwrite: false
    });

    if ((completeRes.status === 401 || (completeRes.body && completeRes.body.code === 'token_not_valid')) && refreshToken) {
        console.log('🔄 Access token expired. Refreshing token and retrying complete-upload...');
        await refreshActiveToken();
        completeRes = await request({
            hostname: 'abrehamrahi.ir',
            path: '/api/v2/flat/complete-upload/',
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${activeAccessToken}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            }
        }, {
            key: key,
            name: fileName,
            parent: parentFolderId,
            upload_id: upload_id,
            parts: completedParts,
            force_overwrite: false
        });
    }

    if (completeRes.status !== 200 && completeRes.status !== 201) {
        throw new Error(`Complete upload failed: ${JSON.stringify(completeRes.body)}`);
    }

    const uploadedFile = completeRes.body;
    console.log(`✨ File saved successfully (ID: ${uploadedFile.id})`);

    // 4. Create Public Link
    console.log('🔗 Generating public download link...');
    let linkRes = await request({
        hostname: 'abrehamrahi.ir',
        path: '/api/v2/sharing/public-link/create/',
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${activeAccessToken}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        }
    }, {
        obj_id: uploadedFile.id
    });

    if ((linkRes.status === 401 || (linkRes.body && linkRes.body.code === 'token_not_valid')) && refreshToken) {
        console.log('🔄 Access token expired. Refreshing token and retrying public link creation...');
        await refreshActiveToken();
        linkRes = await request({
            hostname: 'abrehamrahi.ir',
            path: '/api/v2/sharing/public-link/create/',
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${activeAccessToken}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            }
        }, {
            obj_id: uploadedFile.id
        });
    }

    const publicLink = linkRes.body && linkRes.body.link ? linkRes.body.link : uploadedFile.download_url;

    return {
        id: uploadedFile.id,
        name: uploadedFile.name,
        size: uploadedFile.size,
        public_url: publicLink,
        download_url: uploadedFile.download_url,
        folder_id: parentFolderId,
        created_at: new Date().toISOString()
    };
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

    const refreshToken = params['refresh-token'] || process.env.ABREHAMRAHI_REFRESH_TOKEN;
    const filePath = params['file'] || params['path'];
    const folderPath = params['folder'] || 'Nintendo_Switch';
    const customName = params['name'] || null;

    if (!refreshToken) {
        console.error('❌ Error: Missing refresh token. Pass --refresh-token or set ABREHAMRAHI_REFRESH_TOKEN env.');
        process.exit(1);
    }

    if (!filePath) {
        console.error('❌ Error: Missing file path. Pass --file /path/to/game.nsp');
        process.exit(1);
    }

    try {
        console.log('🔑 Authenticating with AbreHamrahi...');
        const accessToken = await getAccessToken(refreshToken);

        console.log(`🗂️ Resolving target folder: "${folderPath}"...`);
        const folderId = await resolveFolderPath(accessToken, folderPath, refreshToken);

        const result = await uploadFileToHamrahi(accessToken, filePath, folderId, customName, refreshToken);

        console.log('\n=============================================');
        console.log('🎉 UPLOAD COMPLETE!');
        console.log(`📁 Target Folder: ${folderPath} (ID: ${folderId || 'Root'})`);
        console.log(`🎮 Game File:    ${result.name}`);
        console.log(`📦 File Size:    ${(result.size / (1024 * 1024)).toFixed(2)} MB`);
        console.log(`🌐 Public Link:  ${result.public_url}`);
        console.log('=============================================\n');

        // Write output for GitHub Actions if running inside workflow
        if (process.env.GITHUB_OUTPUT) {
            fs.appendFileSync(process.env.GITHUB_OUTPUT, `public_url=${result.public_url}\n`);
            fs.appendFileSync(process.env.GITHUB_OUTPUT, `file_id=${result.id}\n`);
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
    getAccessToken,
    resolveFolderPath,
    uploadFileToHamrahi
};
