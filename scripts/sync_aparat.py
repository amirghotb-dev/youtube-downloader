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
APARAT_USERNAME = os.environ.get("APARAT_USERNAME", "")
APARAT_PASSWORD = os.environ.get("APARAT_PASSWORD", "")

if not SITE_URL:
    print("❌ Error: SITE_URL environment variable is required!")
    sys.exit(1)

def get_headers():
    return {
        "X-API-SECRET": VIDEO_SYNC_SECRET,
        "Accept": "application/json"
    }

def get_pending_tasks():
    """Fetch pending YouTube videos from Laravel backend"""
    url = f"{SITE_URL}/api/video-sync/pending?limit=3"
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

def login_aparat(username, password):
    """Authenticate with Aparat API and retrieve session cookie or token"""
    if not username or not password:
        print("⚠️ Warning: APARAT_USERNAME or APARAT_PASSWORD not provided.")
        return None
    
    login_url = f"https://www.aparat.com/etc/api/login/luser/{username}/lpass/{password}"
    print(f"🔐 Authenticating with Aparat account: {username}")
    try:
        res = requests.get(login_url, timeout=30)
        if res.status_code == 200:
            data = res.json()
            if "login" in data and data["login"].get("type") == "success":
                print("✅ Successfully logged in to Aparat!")
                return data["login"]
            else:
                print(f"❌ Aparat Login failed: {data}")
    except Exception as e:
        print(f"❌ Aparat login exception: {e}")
    return None

def get_upload_form(username, password):
    """Request upload form URL and form Action from Aparat"""
    url = f"https://www.aparat.com/etc/api/uploadform/luser/{username}/lpass/{password}"
    try:
        res = requests.get(url, timeout=30)
        if res.status_code == 200:
            data = res.json()
            upload_info = data.get("uploadform", {})
            if "formAction" in upload_info:
                return upload_info
            else:
                print(f"⚠️ Unexpected upload form structure: {data}")
    except Exception as e:
        print(f"❌ Error getting upload form: {e}")
    return None

def download_youtube_video(youtube_url, output_path):
    """Download video from YouTube using yt-dlp with optimized format (720p mp4)"""
    print(f"⬇️ Downloading video with yt-dlp from: {youtube_url}")
    cmd = [
        "yt-dlp",
        "-f", "bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]/best",
        "--merge-output-format", "mp4",
        "-o", output_path,
        "--no-playlist",
        youtube_url
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode == 0 and os.path.exists(output_path):
        size_mb = os.path.getsize(output_path) / (1024 * 1024)
        print(f"✅ Video downloaded successfully! ({size_mb:.2f} MB)")
        return True
    else:
        print(f"❌ Download failed: {result.stderr}")
        return False

def upload_to_aparat(file_path, title, description, tags, upload_info):
    """Upload video to Aparat using form action endpoint"""
    form_action = upload_info.get("formAction")
    frm_id = upload_info.get("frm-id")

    print(f"🚀 Uploading video to Aparat: '{title}'...")

    tag_str = "-".join([t.strip().replace(" ", "-") for t in tags[:5]])
    
    payload = {
        "frm-id": frm_id,
        "data[title]": title[:100],
        "data[descr]": description[:500] if description else title,
        "data[tags]": tag_str if tag_str else "نینتندو",
        "data[category]": "18", # Game Category in Aparat
        "data[comment]": "yes",
    }

    try:
        with open(file_path, "rb") as f:
            files = {
                "video": (os.path.basename(file_path), f, "video/mp4")
            }
            res = requests.post(form_action, data=payload, files=files, timeout=600)
            
            if res.status_code == 200:
                resp_json = res.json()
                print(f"🎉 Aparat Upload Response: {resp_json}")
                uploadpost = resp_json.get("uploadpost", {})
                uid = uploadpost.get("uid")
                if uid:
                    aparat_url = f"https://www.aparat.com/v/{uid}"
                    print(f"✅ Upload succeeded! Video URL: {aparat_url}")
                    return {
                        "aparat_uid": uid,
                        "aparat_url": aparat_url,
                        "video_embed": f'<style>.h_iframe-aparat_embed_frame{{position:relative;}}.h_iframe-aparat_embed_frame .ratio{{display:block;width:100%;height:auto;}}.h_iframe-aparat_embed_frame iframe{{position:absolute;top:0;left:0;width:100%;height:100%;}}</style><div class="h_iframe-aparat_embed_frame"><span style="display: block;padding-top: 57%"></span><iframe src="https://www.aparat.com/video/video/embed/videohash/{uid}/vt/frame" allowFullScreen="true" webkitallowfullscreen="true" mozallowfullscreen="true"></iframe></div>'
                    }
            else:
                print(f"❌ Upload failed: HTTP {res.status_code} - {res.text}")
    except Exception as e:
        print(f"❌ Exception during upload: {e}")
    return None

def update_site_record(task_id, task_type, aparat_data):
    """Notify Laravel site that video has been uploaded to Aparat"""
    url = f"{SITE_URL}/api/video-sync/update"
    payload = {
        "id": task_id,
        "type": task_type,
        "aparat_uid": aparat_data["aparat_uid"],
        "aparat_url": aparat_data["aparat_url"],
        "video_embed": aparat_data["video_embed"],
    }
    print(f"📝 Updating Laravel site database for {task_type} #{task_id}...")
    try:
        res = requests.post(url, headers=get_headers(), json=payload, timeout=30)
        if res.status_code == 200:
            print(f"✅ Database updated successfully: {res.json().get('message')}")
            return True
        else:
            print(f"⚠️ Failed to update database: HTTP {res.status_code} - {res.text}")
    except Exception as e:
        print(f"❌ Error updating site: {e}")
    return False

def main():
    print("====================================================")
    print("🚀 Starting YouTube to Aparat Cloud Sync Service")
    print("====================================================")

    tasks = get_pending_tasks()
    if not tasks:
        print("✅ No pending videos to transfer.")
        return

    # Check Aparat Credentials
    if not APARAT_USERNAME or not APARAT_PASSWORD:
        print("❌ Error: Aparat credentials not set.")
        return

    # Check Login
    login_info = login_aparat(APARAT_USERNAME, APARAT_PASSWORD)
    if not login_info:
        print("❌ Could not log in to Aparat. Check username/password.")
        return

    with tempfile.TemporaryDirectory() as tmp_dir:
        for idx, task in enumerate(tasks):
            print("----------------------------------------------------")
            print(f"🎬 Processing [{idx+1}/{len(tasks)}] : {task['title']}")
            print(f"🔗 YouTube: {task['youtube_url']}")

            upload_info = get_upload_form(APARAT_USERNAME, APARAT_PASSWORD)
            if not upload_info:
                print("❌ Failed to get Aparat upload form, skipping...")
                continue

            video_file = os.path.join(tmp_dir, f"video_{task['type']}_{task['id']}.mp4")
            
            # Download
            success = download_youtube_video(task['youtube_url'], video_file)
            if not success:
                continue

            # Upload
            aparat_data = upload_to_aparat(
                file_path=video_file,
                title=task.get('title', 'Nintendo Video'),
                description=task.get('description', ''),
                tags=task.get('tags', ['Nintendo', 'Game']),
                upload_info=upload_info
            )

            # Update site
            if aparat_data:
                update_site_record(task['id'], task['type'], aparat_data)

            # Clean temp file
            if os.path.exists(video_file):
                try:
                    os.remove(video_file)
                except Exception:
                    pass

    print("====================================================")
    print("🏁 Sync finished successfully!")

if __name__ == "__main__":
    main()
