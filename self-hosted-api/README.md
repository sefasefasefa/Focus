# Takipçi Paneli — kendi sunucunda lisans API'si

Bu servis lisansları ve AI sağlayıcı anahtarını sunucuda tutar. Eklenti dağıtımına `self-hosted-api` klasörü eklenmez; yalnızca API adresi ve Shopier ödeme bağlantısı gibi herkese açık ayarlar bulunur.

## Gereksinimler

- Node.js 24 veya üzeri
- API klasöründe `npm install` ile kurulmuş bağımlılıklar
- Shopier satıcı hesabı ve geliştirici uygulamasında `order.created` webhook'u
- İnternetten erişilebilir HTTPS adresi (Shopier webhook için zorunlu)
- Hesap ve lisans doğrulama kodları ile parola sıfırlama e-postaları için SMTP erişimi
- Gemini veya Mistral anahtarı gerekiyorsa, yalnızca bu makinedeki `.env` dosyasında

Veriler tek bir yerel SQLite dosyasında tutulur; ayrı PostgreSQL kurulumuna gerek yoktur. Ham Shopier sipariş gövdesi, adres, telefon veya kimlik numarası kaydedilmez. Sadece sipariş numarası, ürün ID'si, lisans durumu ve alıcı e-postasının HMAC özeti saklanır. Hesap e-postaları HMAC özetiyle eşleştirilir; parolalar düz metin olarak saklanmaz.

## İlk kurulum

1. Bu klasörü kendi sunucuna kopyala.
2. Node.js 24 kurulu olsun.
3. Bu klasörde `npm install` çalıştır.
4. `node setup.mjs` çalıştır. Bu, yerel `.env` dosyasını ve lisans imzalama sırlarını oluşturur.
5. `.env` dosyasını **yalnızca sunucuda** düzenle:
   - `SHOPIER_ACCOUNT_ID`: webhook'taki satıcı hesabı ID'si.
   - `SHOPIER_WEBHOOK_TOKEN`: Shopier uygulamasının webhook imzalama anahtarı. İptal ettiğin erişim token'ından farklıdır.
   - `SHOPIER_LICENSE_PRODUCTS`: aylık ürün ID'sini `30` gün olarak eşleştir; ör. `{"SHOPIER_PRODUCT_ID":30}`. Diğer süreler kabul edilmez.
   - `SHOPIER_CHECKOUT_URL`: satın alma sayfasının herkese açık adresi.
   - `SHOPIER_PLAN_DETAILS`: isteğe bağlı olarak aylık ürün ID'sine görünen ad, fiyat etiketi ve HTTPS ödeme bağlantısı tanımla.
   - `PUBLIC_API_BASE_URL`: sunucunun herkese açık HTTPS kök adresi; parola sıfırlama bağlantıları burada oluşturulur.
   - `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`: ücretsiz hesap e-posta doğrulaması, lisans kodları ve parola sıfırlama e-postaları için posta sağlayıcının SMTP bilgileri. Normal posta parolan yerine sağlayıcının uygulama parolasını kullan.
   - `GEMINI_API_KEY` veya `MISTRAL_API_KEY`: seçtiğin AI sağlayıcısının anahtarı. Eklenti ZIP'ine koyma.
6. `npm start` veya Windows'ta `start.bat` ile başlat.
7. Caddy/Nginx gibi bir TLS reverse proxy ile HTTPS aç. Caddy örneği `Caddyfile.example` dosyasındadır; Shopier'e verilecek URL `https://api.senin-domainin.tld/api/webhooks/shopier` olmalı.
8. Shopier geliştirici panelinde `order.created` webhook'u oluştur. İmzayı `Shopier-Signature` başlığından doğrula; bu sunucu doğrulamayı yapar.
9. Dağıtacağın uzantının `extension-work/env.js` dosyasındaki `LICENSE_API_BASE_URL` değerini kendi herkese açık HTTPS API adresine ayarla; `127.0.0.1` yalnızca yerel geliştirme içindir. Uzantıda **Ücretsiz hesap oluştur** seçeneğiyle e-posta ve parola gir. Sunucu e-posta doğrulama kodu gönderir; kod onaylanınca hesap açılır ve 7 günlük ücretsiz deneme başlar. Denemeyi başlatmak için satın alma veya sipariş numarası gerekmez. İlk bağlantıda uzantıya API sunucusu erişim izni ver. Sonraki girişlerde e-posta ve parolanı kullan; e-posta HMAC özetiyle eşleştirilir, parolalar sunucuda scrypt ile özetlenir.
10. 7 günün sonunda korumalı uzantı işlemleri durur. Devam etmek için yalnızca 30 günlük aylık Shopier ürünlerinden biri satın alınmalıdır. Aylık ürünü `SHOPIER_LICENSE_PRODUCTS` içinde `30` gün olarak eşleştir ve `SHOPIER_CHECKOUT_URL` (veya ürün bazında `SHOPIER_PLAN_DETAILS`) ile ödeme bağlantısını tanımla. Ödeme, imzalı webhook ile aynı e-posta hesabına bağlanır.

`SHOPIER_LICENSE_PRODUCTS` ayarlanana kadar ürün webhook'u lisans oluşturmaz. Sadece yapılandırılmış, 30 günlük ürünler ve `paymentStatus=paid` siparişleri kabul edilir; yıllık/ömür boyu ürünler devre dışıdır. Aynı webhook tekrar gelirse ikinci lisans oluşturulmaz. Her e-posta adresi için tek bir 7 günlük deneme oluşturulur; ikinci hesap aynı e-posta ile açılamaz.

## Uç noktalar

- `GET /api/healthz` — sağlık kontrolü
- `GET /api/public-config` — herkese açık satın alma bağlantısı
- `POST /api/webhooks/shopier` — imzalı Shopier `order.created` bildirimi
- `POST /api/license/activate` — satın alma e-postasına lisans etkinleştirme kodu gönderme
- `POST /api/license/activate/verify` — e-posta kodunu doğrulayıp cihaz lisansını etkinleştirme
- `POST /api/license/validate` — kısa ömürlü erişim belirtecini yenileme
- `POST /api/account/register` — ücretsiz hesap oluşturma isteği ve e-posta doğrulama kodu gönderme
- `POST /api/account/register/verify` — kodu doğrulayıp hesabı oluşturma
- `POST /api/account/login` — e-posta/parola girişi ve aboneliğe bağlı lisans token'ı
- `GET /api/account/subscriptions` — deneme ve ücretli abonelik durumu
- `POST /api/account/password/reset/request` — tek kullanımlık parola sıfırlama bağlantısını e-postayla gönderme
- `GET/POST /api/account/password/reset` — sıfırlama sayfası ve parola yenileme
- `DELETE /api/account/session` — bu cihazdaki hesabı çıkarma ve lisans token'larını geçersiz kılma
- `POST /api/ai/gender` — aktif lisansla AI sınıflandırması
- `GET/POST/PATCH/DELETE /api/instagram/session` — lisans/cihaz oturumunu görme, açık onayla bağlama, güncelleme ve silme
- `POST /api/instagram/request` — lisanslı cihazın Instagram REST/GraphQL isteğini kendi oturumu ile iletme

Etkinleştirme varsayılan olarak sipariş başına en fazla iki cihaz kabul eder. `LICENSE_MAX_DEVICES_DEFAULT` ile değiştirilebilir. Lisansı iptal etmek için:

```sh
node --env-file=.env admin.mjs list
node --env-file=.env admin.mjs revoke <shopier-order-id>
```

Hesap oturumları 90 gün geçerlidir. Parola sıfırlama bağlantısı 1 saat sonra geçersiz olur; parola değişince hesap oturumları ve o hesaba bağlı cihaz lisansları iptal edilir. Bu nedenle her hesap için erişebildiğin bir e-posta ve güçlü bir parola kullan.

## Güvenlik

- `.env` ve `data/` klasörü yedeklenmeli, fakat eklentiye veya herkese açık ZIP'e eklenmemeli.
- Shopier webhook token'ı, AI anahtarları ve imzalama sırları sadece bu sunucuda kalmalı.
- SMTP parolası yalnızca sunucudaki `.env` dosyasında veya sunucunun gizli ortam değişkenlerinde kalmalı; eklenti ZIP'ine koyma.
- Instagram oturumu yalnızca eklentide açık kullanıcı onayı verildikten sonra bu sunucuya gönderilir. HTTPS üzerinden gelen çerezler, her lisans/cihaz kaydı için AES-256-GCM ile şifrelenerek diskte saklanır; ham değerler yalnızca istek işlenirken bellekte açılır.
- Eklenti tarayıcıdaki güncel çerezleri her Instagram API isteğinde, çerez değiştiğinde ve beş dakikada bir sunucuya eşitler. Oturum geçersizleşirse tarayıcıda Instagram'a yeniden giriş gerekir; `doc_id` yenilemek oturumun yerini tutmaz.
- Sunucudaki Instagram oturumu lisans siparişi ve cihaz kimliğine bağlıdır. Aynı cihazda başka Instagram hesabına geçmek için önce oturum bağlantısını silip yeni hesap için yeniden açık onay verilmelidir.
- Eklenti kodu istemci tarafında olduğundan cracklenebilir. Sunucu API'si, lisanslar ve anahtarlar korunur; yerel Instagram işlemleri için mutlak kopya/atlatma koruması garanti edilemez.
