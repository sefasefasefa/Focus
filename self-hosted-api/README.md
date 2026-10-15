# Takipçi Paneli — kendi sunucunda lisans API'si

Bu servis lisansları ve AI sağlayıcı anahtarını sunucuda tutar. Eklenti dağıtımına `self-hosted-api` klasörü eklenmez; yalnızca API adresi ve Shopier ödeme bağlantısı gibi herkese açık ayarlar bulunur.

## Gereksinimler

- Node.js 24 veya üzeri
- API klasöründe `npm install` ile kurulmuş bağımlılıklar
- Shopier satıcı hesabı ve geliştirici uygulamasında `order.created` webhook'u
- İnternetten erişilebilir HTTPS adresi (Shopier webhook için zorunlu)
- Parola sıfırlama e-postaları için SMTP erişimi
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
   - `SHOPIER_LICENSE_PRODUCTS`: ör. `{"SHOPIER_PRODUCT_ID":365}`. Değer gün sayısıdır; `0` ömür boyu lisans anlamına gelir.
   - `SHOPIER_CHECKOUT_URL`: satın alma sayfasının herkese açık adresi.
   - `PUBLIC_API_BASE_URL`: sunucunun herkese açık HTTPS kök adresi; parola sıfırlama bağlantıları burada oluşturulur.
   - `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`: kendi posta sağlayıcının SMTP bilgileri. Normal posta parolan yerine sağlayıcının uygulama parolasını kullan.
   - `GEMINI_API_KEY` veya `MISTRAL_API_KEY`: seçtiğin AI sağlayıcısının anahtarı. Eklenti ZIP'ine koyma.
6. `npm start` veya Windows'ta `start.bat` ile başlat.
7. Caddy/Nginx gibi bir TLS reverse proxy ile HTTPS aç. Caddy örneği `Caddyfile.example` dosyasındadır; Shopier'e verilecek URL `https://api.senin-domainin.tld/api/webhooks/shopier` olmalı.
8. Shopier geliştirici panelinde `order.created` webhook'u oluştur. İmzayı `Shopier-Signature` başlığından doğrula; bu sunucu doğrulamayı yapar.
9. Eklentiyi açıp API adresini, Shopier sipariş numarasını ve satın alma e-postasını gir. E-posta cihazda saklanmaz; sunucuda yalnızca HMAC özeti tutulur.

`SHOPIER_LICENSE_PRODUCTS` ayarlanana kadar ürün webhook'u lisans oluşturmaz. Sadece yapılandırılmış ürünler ve `paymentStatus=paid` siparişleri kabul edilir. Aynı webhook tekrar gelirse ikinci lisans oluşturulmaz.

## Uç noktalar

- `GET /api/healthz` — sağlık kontrolü
- `GET /api/public-config` — herkese açık satın alma bağlantısı
- `POST /api/webhooks/shopier` — imzalı Shopier `order.created` bildirimi
- `POST /api/license/activate` — sipariş numarası + satın alma e-postası ile cihaz etkinleştirme
- `POST /api/license/validate` — kısa ömürlü erişim belirtecini yenileme
- `POST /api/account/register` — ücretli Shopier siparişiyle e-posta/parola hesabı oluşturma
- `POST /api/account/login` — e-posta/parola girişi ve aboneliğe bağlı lisans token'ı
- `GET /api/account/subscriptions` — hesaba bağlı abonelikler
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

## Güvenlik

- `.env` ve `data/` klasörü yedeklenmeli, fakat eklentiye veya herkese açık ZIP'e eklenmemeli.
- Shopier webhook token'ı, AI anahtarları ve imzalama sırları sadece bu sunucuda kalmalı.
- SMTP parolası yalnızca sunucudaki `.env` dosyasında veya sunucunun gizli ortam değişkenlerinde kalmalı; eklenti ZIP'ine koyma.
- Instagram oturumu yalnızca eklentide açık kullanıcı onayı verildikten sonra bu sunucuya gönderilir. HTTPS üzerinden gelen çerezler, her lisans/cihaz kaydı için AES-256-GCM ile şifrelenerek diskte saklanır; ham değerler yalnızca istek işlenirken bellekte açılır.
- Eklenti tarayıcıdaki güncel çerezleri her Instagram API isteğinde, çerez değiştiğinde ve beş dakikada bir sunucuya eşitler. Oturum geçersizleşirse tarayıcıda Instagram'a yeniden giriş gerekir; `doc_id` yenilemek oturumun yerini tutmaz.
- Sunucudaki Instagram oturumu lisans siparişi ve cihaz kimliğine bağlıdır. Aynı cihazda başka Instagram hesabına geçmek için önce oturum bağlantısını silip yeni hesap için yeniden açık onay verilmelidir.
- Eklenti kodu istemci tarafında olduğundan cracklenebilir. Sunucu API'si, lisanslar ve anahtarlar korunur; yerel Instagram işlemleri için mutlak kopya/atlatma koruması garanti edilemez.
