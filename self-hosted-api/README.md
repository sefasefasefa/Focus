# Takipçi Paneli — kendi sunucunda lisans API'si

Bu servis lisansları ve AI sağlayıcı anahtarını sunucuda tutar. Eklenti dağıtımına `self-hosted-api` klasörü eklenmez; yalnızca API adresi ve Shopier ödeme bağlantısı gibi herkese açık ayarlar bulunur.

## Gereksinimler

- Node.js 24 veya üzeri
- API klasöründe `npm install` ile kurulmuş bağımlılıklar
- Shopier satıcı hesabı ve geliştirici uygulamasında `order.created` webhook'u
- İnternetten erişilebilir HTTPS adresi (Shopier webhook için zorunlu)
- Hesap ve lisans doğrulama kodları ile parola sıfırlama e-postaları için SMTP erişimi
- Gemini veya Mistral anahtarı gerekiyorsa, yalnızca bu makinedeki `.env` dosyasında

Veriler tek bir yerel SQLite dosyasında tutulur; ayrı PostgreSQL kurulumuna gerek yoktur. Ham Shopier sipariş gövdesi, adres, telefon veya kimlik numarası kaydedilmez. Hesap e-postaları HMAC özetiyle eşleştirilir; parolalar düz metin olarak saklanmaz. Deneme uygunluğu yalnızca doğrulanmış e-posta adresine bağlıdır; donanım kimliği toplanmaz. Aktif hesap, lisans ve Instagram oturumları mevcut oturum kimlikleriyle korunur.

## İlk kurulum

1. Bu klasörü kendi sunucuna kopyala.
2. Node.js 24 veya üzeri kurulu ve ilk çalıştırmada internet bağlantısı hazır olsun.
3. Linux/macOS'ta terminalden `sh start.sh`, Windows'ta `start.bat` çalıştır. Başlatıcı eksik API bağımlılıklarını otomatik kurar ve `.env` yoksa yerel lisans/oturum sırlarını oluşturur. Mevcut `.env` dosyasını değiştirmez.
4. İsteğe bağlı Shopier, SMTP ve AI özellikleri için `.env` dosyasını **yalnızca sunucuda** düzenle:
   - `SHOPIER_ACCOUNT_ID`: webhook'taki satıcı hesabı ID'si.
   - `SHOPIER_WEBHOOK_TOKEN`: Shopier uygulamasının webhook imzalama anahtarı. İptal ettiğin erişim token'ından farklıdır.
   - `SHOPIER_LICENSE_PRODUCTS`: aylık ürün ID'sini `30` gün olarak eşleştir; ör. `{"SHOPIER_PRODUCT_ID":30}`. Diğer süreler kabul edilmez.
   - `SHOPIER_CHECKOUT_URL`: satın alma sayfasının herkese açık adresi.
   - `SHOPIER_PLAN_DETAILS`: isteğe bağlı olarak aylık ürün ID'sine görünen ad, fiyat etiketi ve HTTPS ödeme bağlantısı tanımla.
   - `PUBLIC_API_BASE_URL`: sunucunun herkese açık HTTPS kök adresi; parola sıfırlama bağlantıları burada oluşturulur.
   - `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`: ücretsiz hesap e-posta doğrulaması ve parola sıfırlama e-postaları için posta sağlayıcının SMTP bilgileri. Normal posta parolan yerine sağlayıcının uygulama parolasını kullan.
   - `GEMINI_API_KEY` veya `MISTRAL_API_KEY`: seçtiğin AI sağlayıcısının anahtarı. Eklenti ZIP'ine koyma.

   SMTP ayarları `server.mjs` ile aynı API klasöründeki `.env` dosyasında olmalı. Değişiklikten sonra `start.sh`/`start.bat` ile sunucuyu yeniden başlat; hata artık çalışan süreçte eksik görülen anahtar adlarını değerleri göstermeden listeler.
5. Caddy/Nginx gibi bir TLS reverse proxy ile HTTPS aç. Caddy örneği `Caddyfile.example` dosyasındadır; Shopier'e verilecek URL `https://api.senin-domainin.tld/api/webhooks/shopier` olmalı.
6. Shopier geliştirici panelinde `order.created` webhook'u oluştur. İmzayı `Shopier-Signature` başlığından doğrula; bu sunucu doğrulamayı yapar.
7. Dağıtacağın uzantının `extension-work/env.js` dosyasındaki `LICENSE_API_BASE_URL` değerini kendi herkese açık HTTPS API adresine ayarla; `127.0.0.1` yalnızca yerel geliştirme içindir. Uzantıda **Ücretsiz hesap oluştur** seçeneğiyle e-posta ve parola belirle. Sunucu e-posta doğrulama kodu gönderir; kod onaylanınca hesap açılır, oturum başlar ve 7 günlük ücretsiz deneme başlar. Denemeyi başlatmak için satın alma veya sipariş numarası gerekmez. İlk bağlantıda uzantıya API sunucusu erişim izni ver. Sonraki girişlerde normal e-posta ve parola kullanılır; parolalar sunucuda scrypt ile özetlenir.
8. 7 günün sonunda korumalı uzantı işlemleri durur. Devam etmek için yalnızca 30 günlük aylık Shopier ürünlerinden biri satın alınmalıdır. Aylık ürünü `SHOPIER_LICENSE_PRODUCTS` içinde `30` gün olarak eşleştir ve `SHOPIER_CHECKOUT_URL` (veya ürün bazında `SHOPIER_PLAN_DETAILS`) ile ödeme bağlantısını tanımla. Uzantıdaki ayrı **Aylık satın alma** sayfasından Shopier'e geçilir; ödeme sırasında hesaba kayıtlı aynı e-posta kullanılmalıdır. İmzalı webhook ödemeyi hesaba bağlar. Satın alım sonrasında **Satın alımı kontrol et** denildiğinde ücretli lisans hesaba verilir; satın alma e-postası koduyla ayrıca etkinleştirme gerekmez.

`SHOPIER_LICENSE_PRODUCTS` ayarlanana kadar ürün webhook'u lisans oluşturmaz. Sadece yapılandırılmış, 30 günlük ürünler ve `paymentStatus=paid` siparişleri kabul edilir; yıllık/ömür boyu ürünler devre dışıdır. Aynı webhook tekrar gelirse ikinci lisans oluşturulmaz. Doğrulanan her e-posta adresi için tek bir 7 günlük deneme açılır; eski cihaz geçmişi deneme uygunluğunu etkilemez ve cihaz sayısı sınırı uygulanmaz. Daha önce doğrulanmış fakat deneme kaydı bulunmayan hesapta deneme sonraki giriş/oturum yenilemede başlar; süresi dolmuş deneme yeniden başlatılmaz. Eski deneme geçmişi ve eski sunucuya kaydedilmiş Instagram oturum kopyaları yeni sürümün ilk açılışında temizlenir; hesap ve lisans kayıtları korunur.

## Uç noktalar

- `GET /api/healthz` — sağlık kontrolü
- `GET /api/public-config` — herkese açık satın alma bağlantısı
- `POST /api/webhooks/shopier` — imzalı Shopier `order.created` bildirimi
- `POST /api/license/validate` — kısa ömürlü erişim belirtecini yenileme
- `POST /api/account/register` — ücretsiz hesap oluşturma isteği ve e-posta doğrulama kodu gönderme
- `POST /api/account/register/verify` — kodu doğrulayıp hesabı oluşturma
- `POST /api/account/login` — e-posta/parola girişi ve aboneliğe bağlı lisans token'ı
- `GET /api/account/subscriptions` — deneme ve ücretli abonelik durumu
- `POST /api/account/license/refresh` — hesap oturumuna bağlı en güncel etkin deneme/ücretli lisansı bu cihaza ver
- `POST /api/account/password/reset/request` — tek kullanımlık parola sıfırlama bağlantısını e-postayla gönderme
- `GET/POST /api/account/password/reset` — sıfırlama sayfası ve parola yenileme
- `DELETE /api/account/session` — bu cihazdaki hesabı çıkarma ve lisans token'larını geçersiz kılma
- `POST /api/ai/gender` — aktif lisansla AI sınıflandırması
- `POST /api/instagram/request` — lisanslı cihazın o işlem için gönderdiği güncel tarayıcı oturumuyla Instagram REST/GraphQL isteğini iletme; oturum API veritabanında saklanmaz

Hesap ve lisans oturumlarını sunucu, uzantının oluşturduğu oturum kimliğiyle ilişkilendirir; bu kimlik donanımdan okunmaz ve deneme hakkını sınırlamak için kullanılmaz. Aylık lisansın 30 günlük süresi ve Instagram'ın kendi istek sınırları devam eder. Lisansı iptal etmek için:

```sh
node --env-file=.env admin.mjs list
node --env-file=.env admin.mjs revoke <shopier-order-id>
```

Hesap oturumları 90 gün geçerlidir. Parola sıfırlama bağlantısı 1 saat sonra geçersiz olur; parola değişince hesap oturumları ve o hesaba bağlı cihaz lisansları iptal edilir. Bu nedenle her hesap için erişebildiğin bir e-posta ve güçlü bir parola kullan.

## Güvenlik

- `.env` ve `data/` klasörü yedeklenmeli, fakat eklentiye veya herkese açık ZIP'e eklenmemeli.
- Shopier webhook token'ı, AI anahtarları ve imzalama sırları sadece bu sunucuda kalmalı.
- SMTP parolası yalnızca sunucudaki `.env` dosyasında veya sunucunun gizli ortam değişkenlerinde kalmalı; eklenti ZIP'ine koyma.
- Eklenti oturum çerezlerini her Instagram API isteği sırasında tarayıcıdan okur ve sadece o isteğin gövdesinde HTTPS üzerinden API’ye yollar. API bunları yalnızca bellekte kullanır; veritabanına yazmaz ve sonraki isteklerde önceki bir oturumu aramaz.
- Eski sürümlerin şifreli Instagram oturum kopyaları yükseltme sonrası ilk API başlangıcında silinir. Yeni akışta sunucu oturumu bağlama, eşitleme veya kaldırma uç noktası yoktur.
- Oturum geçersizleşirse tarayıcıda Instagram'a yeniden giriş gerekir; `doc_id` yenilemek oturumun yerini tutmaz.
- Eklenti kodu istemci tarafında olduğundan cracklenebilir. Sunucu API'si, lisanslar ve anahtarlar korunur; yerel Instagram işlemleri için mutlak kopya/atlatma koruması garanti edilemez.
