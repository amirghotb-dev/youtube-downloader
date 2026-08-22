# 🎬 YouTube Video Downloader & Sync Worker (GitHub Actions)

این مخزن به صورت خودکار از طریق **GitHub Actions** ویدیوهای تریلر و گیم‌پلی‌های یوتیوب مربوط به وب‌سایت نینتندو را با نهایت سرعت دانلود کرده و مستقیماً روی هاست وبلاگ آپلود می‌کند تا کاربران داخل ایران بدون نیاز به فیلترشکن ویدیوها را تماشا کنند.

---

## ⚙️ راهنمای تنظیم Secrets در مخزن گیت‌هاب (Settings -> Secrets and variables -> Actions)

در ریپازیتوری گیت‌هاب خود، به مسیر زیر بروید:
**Settings** > **Secrets and variables** > **Actions** > **New repository secret**

سه متغیر مخفی زیر را ایجاد کنید:

| نام سکرت (Name) | مقدار (Value) | توضیح |
| :--- | :--- | :--- |
| `SITE_URL` | `https://ninten2.ir` (آدرس سایت شما) | آدرس دامنه اصلی سایت لاراول |
| `SYNC_API_TOKEN` | `ninten2-sync-secret-key-2026` | توکن اعتبارسنجی ارتباط امن |
| `YOUTUBE_COOKIES` | متن داخل فایل `youtube_cookies.txt` | کوکی‌های یوتیوب برای عبور از محدودیت‌ها |

---

## 🚀 نحوه اجرا:
1. **اجرای خودکار:** به صورت پیش‌فرض این ورک‌فلو هر ۱ ساعت یکبار اجرا می‌شود.
2. **اجرای دستی:** در گیت‌هاب به تب **Actions** > **YouTube Video Sync Worker** رفته و روی **Run workflow** کلیک کنید.
