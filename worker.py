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
    print(f"🎬 در حال دانلود ویدیو از: {url}")
    
    ydl_opts = {
        'format': 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
        'outtmpl': os.path.join(output_dir, '%(id)s.%(ext)s'),
        'quiet': False,
        'no_warnings': False,
        'remote_components': ['ejs:github'],
    }

    # در صورت وجود فایل کوکی اختصاصی
    if cookie_path and os.path.exists(cookie_path):
        print(f"🍪 استفاده از فایل کوکی: {cookie_path}")
        ydl_opts['cookiefile'] = cookie_path

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
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

def upload_video_to_site(item_type, item_id, file_path):
    url = f"{SITE_URL}/api/v1/sync/upload-video"
    headers = {
        "X-SYNC-TOKEN": SYNC_API_TOKEN,
        "Accept": "application/json"
    }
    
    file_size_mb = os.path.getsize(file_path) / (1024 * 1024)
    print(f"🚀 در حال آپلود ویدیو ({file_size_mb:.2f} MB) به سایت...")

    try:
        with open(file_path, "rb") as f:
            files = {
                "video": (os.path.basename(file_path), f, "video/mp4")
            }
            data = {
                "type": item_type,
                "id": item_id
            }
            res = requests.post(url, headers=headers, data=data, files=files, timeout=300)
            if res.status_code == 200:
                print(f"✅ با موفقیت آپلود و در دیتابیس ثبت شد: {res.json().get('local_video_path')}")
                return True
            else:
                print(f"❌ خطای آپلود ({res.status_code}): {res.text}")
                return False
    except Exception as e:
        print(f"❌ خطا در آپلود به سرور: {e}")
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
                
                # ۲. آپلود به سایت
                if downloaded_file and os.path.exists(downloaded_file):
                    success = upload_video_to_site(item_type, item_id, downloaded_file)
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
