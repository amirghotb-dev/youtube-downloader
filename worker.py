import os
import sys
import re
import requests
import yt_dlp
import tempfile
import time

# متغیرهای محیطی دریافتی از گیت‌هاب یا فایل .env
SITE_URL = os.environ.get("SITE_URL", "https://your-domain.com").rstrip("/")
SYNC_API_TOKEN = os.environ.get("SYNC_API_TOKEN", "ninten2-sync-secret-key-2026")
YOUTUBE_COOKIES_DATA = os.environ.get("YOUTUBE_COOKIES", "")

def get_pending_videos():
    url = f"{SITE_URL}/api/v1/sync/pending-videos"
    headers = {
        "X-SYNC-TOKEN": SYNC_API_TOKEN,
        "Accept": "application/json"
    }
    try:
        print(f"📡 دریافت لیست ویدیوهای در انتظار از: {url}")
        res = requests.get(url, headers=headers, timeout=15)
        if res.status_code == 200:
            data = res.json()
            return data.get("data", [])
        else:
            print(f"❌ خطای سرور ({res.status_code}): {res.text}")
            return []
    except Exception as e:
        print(f"❌ خطا در اتصال به سایت: {e}")
        return []

def download_video(url, output_dir, cookie_path=None):
    os.makedirs(output_dir, exist_ok=True)
    
    # تبدیل لینک به فرمت استاندارد watch
    match = re.search(r"(?:v=|\/embed\/|youtu\.be\/)([a-zA-Z0-9_-]{11})", url)
    target_url = f"https://www.youtube.com/watch?v={match.group(1)}" if match else url

    print(f"🎬 در حال دانلود ویدیو از: {target_url}")
    
    ydl_opts = {
        # اولویت کیفیت 480p کم‌حجم و بهینه (کاهش چشمگیر حجم فایل و سرعت پخش بالا)
        'format': 'bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/best[height<=480][ext=mp4]/best[height<=720][ext=mp4]/best',
        'outtmpl': os.path.join(output_dir, '%(id)s.%(ext)s'),
        'quiet': False,
        'no_warnings': False,
        'remote_components': ['ejs:github'],
        'extractor_args': {
            'youtube': {
                'player_client': ['android', 'ios', 'tv_embedded', 'web_creator', 'web'],
                'player_skip': ['webpage', 'configs'],
            }
        },
        'age_limit': 99,
    }

    # در صورت وجود فایل کوکی اختصاصی
    if cookie_path and os.path.exists(cookie_path):
        print(f"🍪 استفاده از فایل کوکی: {cookie_path}")
        ydl_opts['cookiefile'] = cookie_path

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(target_url, download=True)
            video_id = info.get('id')
            title = info.get('title')
            ext = info.get('ext', 'mp4')
            file_path = os.path.join(output_dir, f"{video_id}.{ext}")
            
            print(f"\n✅ دانلود با موفقیت کامل شد!")
            print(f"📌 عنوان: {title}")
            print(f"📁 مسیر ذخیره: {file_path}")
            return file_path
    except Exception as e:
        print(f"❌ خطا در دانلود ویدیو: {e}")
        return None

import subprocess
import json

def upload_video_to_hamrahi(file_path, folder_path="Nintendo_Videos"):
    """
    Uploads downloaded video file to AbreHamrahi Cloud via hamrahi_uploader.cjs
    Returns the public URL of the uploaded video.
    """
    refresh_token = os.environ.get("ABREHAMRAHI_REFRESH_TOKEN", "")
    if not refresh_token:
        print("⚠️ هشدار: متغیر ABREHAMRAHI_REFRESH_TOKEN تنظیم نشده است.")
        return None

    uploader_path = os.path.join(os.path.dirname(__file__), "hamrahi_uploader.cjs")
    if not os.path.exists(uploader_path):
        uploader_path = os.path.join(os.getcwd(), "hamrahi_uploader.cjs")

    cmd = [
        "node",
        uploader_path,
        "--file", file_path,
        "--folder", folder_path,
        "--concurrency", "4"
    ]

    print(f"☁️ در حال آپلود ویدیو به ابر همراهی (پوشه: {folder_path})...")
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
        stdout = proc.stdout
        
        # Extract public link from output
        match = re.search(r"🌐 Public Link:\s*([^\r\n]+)", stdout)
        if match:
            public_url = match.group(1).strip()
            print(f"✅ با موفقیت در ابر همراهی آپلود شد: {public_url}")
            return public_url
        else:
            print(f"❌ خروجی uploader فاقد لینک عمومی بود:\n{stdout}\n{proc.stderr}")
            return None
    except Exception as e:
        print(f"❌ خطا در اجرای hamrahi_uploader.cjs: {e}")
        return None

def send_video_url_to_site(item_type, item_id, public_video_url):
    url = f"{SITE_URL}/api/v1/sync/upload-video"
    headers = {
        "X-SYNC-TOKEN": SYNC_API_TOKEN,
        "Accept": "application/json",
        "Content-Type": "application/json"
    }
    
    payload = {
        "type": item_type,
        "id": item_id,
        "direct_url": public_video_url
    }
    
    print(f"📡 در حال ثبت لینک ابر همراهی در وب‌سایت...")
    try:
        res = requests.post(url, headers=headers, json=payload, timeout=30)
        if res.status_code == 200:
            print(f"✅ لینک با موفقیت در سایت ثبت شد: {res.json().get('local_video_path')}")
            return True
        else:
            print(f"❌ خطای ثبت در سرور ({res.status_code}): {res.text}")
            return False
    except Exception as e:
        print(f"❌ خطا در اتصال به سرور سایت: {e}")
        return False

def main():
    print("========================================")
    print("🎮 Ninten2 YouTube Video Sync Worker")
    print("========================================")

    # تعیین مسیر کوکی
    cookie_path = None
    if YOUTUBE_COOKIES_DATA.strip():
        cookie_file = tempfile.NamedTemporaryFile(mode='w', delete=False, suffix='.txt')
        cookie_file.write(YOUTUBE_COOKIES_DATA)
        cookie_file.close()
        cookie_path = cookie_file.name
        print("🍪 کوکی‌های یوتیوب از Secret گیت‌هاب بارگذاری شدند.")
    else:
        # جستجوی فایل کوکی در مسیرهای مختلف پروژه
        possible_cookie_paths = [
            os.path.join(os.getcwd(), "cookies.txt"),
            os.path.join(os.getcwd(), "youtube_cookies.txt"),
            os.path.join(os.path.dirname(__file__), "..", "..", "cookies.txt"),
            os.path.join(os.path.dirname(__file__), "..", "..", "youtube_cookies.txt"),
            os.path.join(os.path.dirname(__file__), "cookies.txt"),
            os.path.join(os.path.dirname(__file__), "youtube_cookies.txt"),
        ]
        for p in possible_cookie_paths:
            if os.path.exists(p):
                cookie_path = os.path.abspath(p)
                print(f"🍪 فایل کوکی شناسایی شد: {cookie_path}")
                break

    pending_list = get_pending_videos()
    if not pending_list:
        print("🎉 هیچ ویدیوی جدیدی برای دانلود وجود ندارد.")
        return

    print(f"📋 تعداد {len(pending_list)} ویدیو برای پردازش یافت شد.\n")

    with tempfile.TemporaryDirectory() as temp_dir:
        for idx, item in enumerate(pending_list, 1):
            item_type = item.get("type")
            item_id = item.get("id")
            title = item.get("title", "بدون عنوان")
            yt_url = item.get("youtube_url")

            print(f"\n[{idx}/{len(pending_list)}] پردازش: {title} (ID: {item_id}, Type: {item_type})")
            
            try:
                # ۱. دانلود ویدیو با استفاده از کوکی
                downloaded_file = download_video(yt_url, temp_dir, cookie_path)
                
                # ۲. آپلود به ابر همراهی و ثبت لینک در سایت
                if downloaded_file and os.path.exists(downloaded_file):
                    public_video_url = upload_video_to_hamrahi(downloaded_file, folder_path="Nintendo_Videos")
                    if public_video_url:
                        success = send_video_url_to_site(item_type, item_id, public_video_url)
                    else:
                        print("⚠️ آپلود ویدیو به ابر همراهی ناموفق بود.")
                    
                    # پاک کردن فایل موقت پس از آپلود
                    if os.path.exists(downloaded_file):
                        os.remove(downloaded_file)
                else:
                    print("⚠️ دانلود ویدیو ناموفق بود.")
            except Exception as e:
                print(f"❌ خطا در پردازش ویدیو {yt_url}: {e}")

            time.sleep(2)

    # پاک کردن کوکی موقت
    if cookie_path and not cookie_path.endswith("cookies.txt") and not cookie_path.endswith("youtube_cookies.txt") and os.path.exists(cookie_path):
        os.remove(cookie_path)

    print("\n🏁 فرآیند همگام‌سازی به پایان رسید.")

if __name__ == "__main__":
    main()
