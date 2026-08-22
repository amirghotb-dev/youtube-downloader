import os
import sys
import json
import time
import requests
import subprocess
import tempfile
from pathlib import Path

# Load config from Environment variables
SITE_URL = os.environ.get("SITE_URL", "").rstrip("/")
VIDEO_SYNC_SECRET = os.environ.get("VIDEO_SYNC_SECRET", "ninten2_secret_sync_key_2026")
MAX_VIDEOS_PER_RUN = int(os.environ.get("MAX_VIDEOS_PER_RUN", "3"))
YOUTUBE_COOKIES = os.environ.get("YOUTUBE_COOKIES", "").strip()

if not SITE_URL:
    print("❌ Error: SITE_URL environment variable is required!")
    sys.exit(1)

# Write cookies to temporary file if available
COOKIES_FILE = None
if YOUTUBE_COOKIES:
    try:
        temp_cookie = tempfile.NamedTemporaryFile(mode='w', delete=False, suffix='.txt')
        temp_cookie.write(YOUTUBE_COOKIES)
        temp_cookie.close()
        COOKIES_FILE = temp_cookie.name
        print("🍪 YouTube cookies loaded successfully from secrets.")
    except Exception as e:
        print(f"⚠️ Warning: Could not create temporary cookie file: {e}")

def get_headers():
    return {
        "X-API-SECRET": VIDEO_SYNC_SECRET,
        "Accept": "application/json"
    }

def get_pending_tasks():
    """Fetch pending YouTube videos from Laravel backend"""
    url = f"{SITE_URL}/api/video-sync/pending?limit={MAX_VIDEOS_PER_RUN}"
    print(f"📡 Checking pending video tasks from: {url}")
    try:
        res = requests.get(url, headers=get_headers(), timeout=30)
        if res.status_code == 200:
            data = res.json()
            tasks = data.get("tasks", [])
            print(f"✨ Found {len(tasks)} pending video(s).")
            return tasks
        else:
            print(f"⚠️ Failed to get tasks: HTTP {res.status_code} - {res.text}")
    except Exception as e:
        print(f"❌ Error connecting to site: {e}")
    return []

import re

def normalize_youtube_url(url):
    """Convert embed or short URLs to standard watch URL"""
    match = re.search(r'(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})', url)
    if match:
        return f"https://www.youtube.com/watch?v={match.group(1)}"
    return url

def download_youtube_video(youtube_url, output_path):
    """
    Download video from YouTube using yt-dlp with multiple client and cookie fallback strategies.
    """
    clean_url = normalize_youtube_url(youtube_url)
    print(f"⬇️ Downloading video with yt-dlp: {clean_url}")
    
    # Try strategies in order of reliability for YouTube bot evasion and datacenter IP rate limits
    strategies = [
        # Strategy 1: android_vr (bypasses bot detection & sign-in checks on datacenter IPs)
        {
            "name": "Android VR client",
            "use_cookies": False,
            "args": ["--extractor-args", "youtube:player_client=android_vr"]
        },
        # Strategy 2: tv_embedded client
        {
            "name": "TV Embedded client",
            "use_cookies": False,
            "args": ["--extractor-args", "youtube:player_client=tv_embedded"]
        },
        # Strategy 3: android_vr with cookies
        {
            "name": "Android VR (With cookies)",
            "use_cookies": True,
            "args": ["--extractor-args", "youtube:player_client=android_vr"]
        },
        # Strategy 4: Web embedded
        {
            "name": "Web embedded",
            "use_cookies": True,
            "args": ["--extractor-args", "youtube:player_client=mweb,web_embedded"]
        },
        # Strategy 5: Standard Web with cookies
        {
            "name": "Standard Web (With cookies)",
            "use_cookies": True,
            "args": ["--extractor-args", "youtube:player_client=web"]
        },
        # Strategy 6: Default auto
        {
            "name": "Default auto",
            "use_cookies": False,
            "args": []
        }
    ]
    
    for idx, strat in enumerate(strategies, 1):
        print(f"🔄 Attempt {idx}/{len(strategies)} using [{strat['name']}]...")
        
        cmd = [
            "yt-dlp",
            *strat["args"],
            "-f", "best[ext=mp4]/bestvideo[height<=720]+bestaudio/best[height<=720]/best",
            "--merge-output-format", "mp4",
            "-o", output_path,
            "--no-playlist",
            "--no-check-certificates",
            "--retries", "3",
            "--socket-timeout", "30",
        ]
        
        if strat["use_cookies"] and COOKIES_FILE and os.path.exists(COOKIES_FILE):
            cmd.extend(["--cookies", COOKIES_FILE])
            
        cmd.append(clean_url)
        
        result = subprocess.run(cmd, capture_output=True, text=True)
        
        if os.path.exists(output_path) and os.path.getsize(output_path) > 10000:
            size_mb = os.path.getsize(output_path) / (1024 * 1024)
            print(f"✅ Video downloaded successfully using [{strat['name']}]! ({size_mb:.2f} MB)")
            return True
        else:
            err_msg = (result.stderr or result.stdout or "").strip()
            # Pick a meaningful short error line
            lines = [l for l in err_msg.split('\n') if 'ERROR' in l or 'HTTP Error' in l or 'Sign in' in l]
            short_err = lines[-1] if lines else (err_msg.split('\n')[-1] if err_msg else "Unknown error")
            print(f"⚠️ [{strat['name']}] failed: {short_err}")
            time.sleep(1)
            
    print("❌ All download strategies failed for this video.")
    return False

def upload_video_to_site(task, file_path):
    """
    Upload the downloaded MP4 video directly to Laravel backend.
    """
    upload_url = f"{SITE_URL}/api/video-sync/upload"
    print(f"🚀 Uploading video to: {upload_url} for {task['type']} #{task['id']} ({task['title']})")
    
    try:
        with open(file_path, 'rb') as video_file:
            files = {
                'video': (os.path.basename(file_path), video_file, 'video/mp4')
            }
            data = {
                'id': task['id'],
                'type': task['type']
            }
            
            headers = {
                "X-API-SECRET": VIDEO_SYNC_SECRET,
                "Accept": "application/json"
            }
            
            response = requests.post(
                upload_url,
                files=files,
                data=data,
                headers=headers,
                timeout=300 # 5 min timeout for large file upload
            )
            
            if response.status_code == 200:
                result = response.json()
                print(f"🎉 Success! Video attached: {result.get('video_url')}")
                return True
            else:
                print(f"❌ Upload failed: HTTP {response.status_code} - {response.text}")
                return False
    except Exception as e:
        print(f"❌ Exception during video upload: {e}")
        return False

def main():
    print("=" * 60)
    print("🚀 Starting YouTube to Self-Hosted Video Sync Service")
    print("=" * 60)
    
    tasks = get_pending_tasks()
    if not tasks:
        print("☕ No pending videos to process. Exiting cleanly.")
        return

    success_count = 0
    with tempfile.TemporaryDirectory() as tmp_dir:
        for index, task in enumerate(tasks, 1):
            print(f"\n--- [{index}/{len(tasks)}] Processing: {task['title']} ---")
            print(f"🔗 Target: {task['type']} #{task['id']}")
            print(f"📺 YouTube: {task['youtube_url']}")

            video_filename = f"video_{task['type']}_{task['id']}.mp4"
            video_file = os.path.join(tmp_dir, video_filename)

            # Step 1: Download from YouTube
            downloaded = download_youtube_video(task['youtube_url'], video_file)
            if not downloaded:
                print("⏭️ Skipping due to download error.")
                continue

            # Step 2: Upload directly to Laravel site
            uploaded = upload_video_to_site(task, video_file)
            if uploaded:
                success_count += 1

            # Cleanup temp file
            if os.path.exists(video_file):
                try:
                    os.remove(video_file)
                except Exception:
                    pass

            time.sleep(2)

    print("\n" + "=" * 60)
    print(f"🏁 Video Sync Complete! Successfully synced: {success_count}/{len(tasks)} videos.")
    print("=" * 60)

if __name__ == "__main__":
    main()
