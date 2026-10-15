# Takipçi Paneli

## 1.0.149 Sunucu üzerinden Instagram işlemleri ve oturum eşitleme

- Takipçi/takip listesi, takip isteği ve beğeni API istekleri artık lisans
  sunucusundaki Instagram proxy'sinden geçirilir.
- Eklenti, kullanıcı lisans merkezinde açıkça onayladıktan sonra Instagram
  oturum çerezlerini HTTPS ile kendi sunucusuna iletir. Oturum; her API isteğinde,
  çerez değişikliğinde ve beş dakikalık aralıklarla güncellenir.
- Sunucu oturumu lisans/cihaz bazında AES-256-GCM ile saklar. Instagram hesabı
  değişirse oturum kendiliğinden başka hesaba geçirilmez; kullanıcı yeniden
  açık onay vermelidir.
- `doc_id` ve GraphQL değişkenleri istek gövdesinde sunucuya iletilir; `doc_id`
  oturum çerezi değildir ve oturumu yenilemez.

## 1.0.148 Gönderi kısmi hata sonucu korunuyor

- Kullanılabilir gönderi verisiyle birlikte gelen isteğe bağlı
  `location.profile_pic_url` GraphQL hataları, üst katmanda ikinci kez hata
  sayılıp gönderileri kaybettirmiyor.
- İsteğe bağlı hata adedi günlükte tutuluyor; diğer GraphQL hataları yine
  işlemi durduruyor.

## 1.0.147 Gönderi GraphQL varyantı düzeltmesi

- Instagram'dan yakalanan `PolarisProfilePostsQuery` ve
  `PolarisProfilePostsTabContentQuery_connection` Posts işlemleri desteklenir.
- Yedek sorguda yakalanan işlem adı ve doc_id birlikte kullanılır; hedef hesap
  adı her aday için `username` değişkenine aktarılır.
- Yalnızca gönderi verisi mevcutken gelen isteğe bağlı
  `location.profile_pic_url` GraphQL hataları göz ardı edilir; diğer hatalar
  durdurma davranışını korur.

## 1.0.146 Gönderi REST/GraphQL yedeği

- Sayısal ve kullanıcı adı gönderi REST adresleri geçici HTML/çerçeve yanıtı
  verdiğinde, Instagram sayfasından yakalanmış güncel
  `PolarisProfilePostsTabContentQuery_connection` işlemi yedek okunur.
- Yalnızca mevcut doc_id ve değişken şeması kullanılır; eski/sabit bir sorgu
  kimliği tahmin edilmez. Açık rate-limit, oturum ve erişim engellerinde
  yedek sorgu gönderilmez.
- GraphQL yedeğinin sonuç sayısı ve başarısı debug günlüğüne eklenir.

## 1.0.145 Kesilen tarama için kısmi sonuç kartı

- Rate-limit, oturum koruması veya başka bir sert durdurma içerik taramasını
  yarıda keserse o ana kadarki hikaye/gönderi/Reels durumları artık kaydedilir.
- Kontrol sırası durduğu içerik türü kartta “Kontrol tamamlanmadı” olarak ve
  durma nedeni ile gösterilir; önceki turun eksik kartı kalmaz.
- Debug günlüğüne son aday, içerik türü ve durdurma nedeni eklenir.

## 1.0.144 Reels geçici hata fallback raporu

- Reels yanıtındaki geçici HTML/çerçeve hataları artık genel otomasyon durdurma
  kontrolünden önce sınıflandırılır; hata `retry_pending` olarak raporlanıp
  sonraki tur planlanır.
- Gerçek rate-limit, oturum ve erişim korumalarında mevcut durdurma davranışı
  korunur.
- İçerik türü seçimi, gönderiden Reels'e geçiş ve Reels kontrol başlangıcı
  debug kaydına eklenir.

## 1.0.143 Instagram rate-limit kaydı

- HTTP 200 içinde gelen `Rate limit exceeded` dahil açık istek sınırı yanıtları
  GraphQL hata kartı yerine uyarı olarak kaydedilir.
- Durum metni artık gerçek HTTP 429 alınmadıysa yanlış biçimde “429 yanıtı” demez.
- Instagram'ın ortak istek sınırı ve mevcut 30 dakika bekleme davranışı korunur;
  sınır geldiğinde başka içerik türlerine geçip ek istek gönderilmez.

## 1.0.142 Beğeni güvenlik kontrolü raporu

- Hikaye/gönderi/Reels bulunduğu halde canlı takip ilişkisi doğrulanmadığı için
  beğeni atlanırsa, kontrol kartında neden açıkça gösterilir.
- Takip doğrulama güvenlik kontrolü korunur; doğrulanamayan hesaplarda beğeni
  isteği gönderilmez.

## 1.0.141 Chrome ana çerçeve gezinme hatası

- `Frame with ID 0 was removed` ve aynı türdeki çerçeve kaybolma hataları,
  geçici sekme/çerçeve sorunu olarak tanınır.
- Instagram sekmesi yeniden seçilip yüklenmesi beklendikten sonra istek bir kez
  denenir; bu hata gereksiz bir API/oturum hatası gibi kaydedilmez.

## 1.0.140 AI 503 ve geçici Instagram yanıtları

- Gemini HTTP 503 için sağlayıcının bekleme bilgisi varsa uygulanır; yoksa tek
  yeniden deneme 30 saniye bekler ve sonrasında aynı süreli sağlayıcı beklemesi
  korunur.
- 429/503 AI yanıtları ve geçici Instagram HTML kabuğu hataları, ayrıntıları
  korunarak uyarı seviyesinde kaydedilir; konsola `[object Object]` yazdırılmaz.

## 1.0.139 Sayısal gönderi adresine kullanıcı adı yedeği

- Sayısal kullanıcı ID'siyle gönderi isteği Instagram ana sayfasının HTML'ine
  yönlenirse mevcut kullanıcı adı uç noktası bir kez denenir.
- Yedek yalnızca geçici HTML/boş yanıt durumunda çalışır; oturum, doğrulama ve
  hız sınırı engellerinde ek istek gönderilmez.

## 1.0.138 İçerik yedeği: geçici hikâye/gönderi okuma hataları

- Hikâye veya gönderi listesi geçici HTML/boş yanıt verirse, belirsiz beğeni
  mutasyonu oluşmadığı sürece otomasyon diğer seçili içerik türüne geçer.
- 401/403/429, doğrulama ve beğeni mutasyonu sonrası belirsiz yanıtlar genel
  güvenlik durdurması olarak kalır.

## 1.0.137 Sayısal profil gönderi isteği köprü izni

- Sayfa-içi fetch köprüsü, sayısal kullanıcı kimliğiyle çağrılan gönderi
  uç noktasını da salt-okunur yedek istek olarak kabul eder.
- Yedek istek Instagram sayfasının oturum/WWW-claim başlıklarını kullanır.

## 1.0.136 Gönderi hatası düzeltmesi ve takip kartı tarihi

- Gönderi kontrolünde tekrar eden `field_exception` hatasına yol açan profil
  GraphQL sorgusu kaldırıldı; beğeni panelinde zaten kullanılan Instagram REST
  gönderi uç noktası tercih ediliyor.
- REST gönderi isteği geçici olarak HTML'e yönlendirilirse, salt-okunur istek
  için Instagram sayfasının kendi fetch bağlamı yedek olarak kullanılabilir.
- Başarılı takip isteği kartlarında kayıtlı gönderim tarihi ve saati gösterilir.

## 1.0.135 Gönderi GraphQL kısmi hatasını güvenli işleme

- Instagram gönderi verisiyle birlikte yalnızca isteğe bağlı
  `location.profile_pic_url` hataları döndürdüğünde mevcut medya verisi korunur.
- Gönderi verisi yoksa veya başka bir GraphQL alanı hata verirse istek yine
  başarısız sayılır; hata kaydına güvenli GraphQL alan yolu eklenir.

## 1.0.134 Profil yedeği kapsam hatasını düzeltme

- Profil verisini alan `executeScript` fonksiyonu artık takipçi, takip edilen ve
  gönderi sayılarını kendi izole bağlamında normalleştiriyor.
- Arka plan sayfasındaki yardımcı fonksiyon bulunamadığı için oluşan
  `profileCount is not defined` hatası giderildi.

## 1.0.133 Beğeni ve takip sonrası keşfi birbirinden ayırma

- Başarılı beğeniden sonra takip keşfi ayrı çalışır; aday taraması ve ortak
  hesap beklemesi beğeni zamanlayıcısını bekletmez.
- Eşzamanlı keşif işleri birikmez; devam eden tarama varken yalnızca son beğenilen
  hesap sıraya alınır.
- Takip adayı bulunamadığında, ortak hesap ve cinsiyet filtrelerini geçen kimse
  olup olmadığı durum mesajında belirtilir.

## 1.0.132 Beğeni öncesi canlı takip doğrulaması

- Otomatik hikâye, gönderi ve Reels beğenilerinden hemen önce hesabın hâlâ takip edildiğini doğrula.
- Başka bir profilin takip listesini oturum sahibinin önbelleğine yazma veya bu önbellekten otomasyon adayı seçme.
- Takip durumu doğrulanamazsa beğeni gönderme.

## 1.0.131 Instagram'dan operasyon ve değişken yakalama

- Gönderi, Reels ve gönderi/Reels beğeni doc_id değerleri Instagram'ın kendi
  isteklerinden operasyon adına göre otomatik yakalanır ve sonraki çağrılarda
  kullanılır; sorgu değişkenleri de yakalanan Instagram şablonundan alınır.
- İlk yakalama öncesinde HAR'da doğrulanan sabit değerler başlangıç yedeğidir.

## 1.0.130 HAR doc_id değerlerini statik kullanma

- Gönderi, Reels ve beğeni işlemleri HAR’da görülen sabit doc_id değerlerini
  kullanır; çalışma anında başka istekleri yakalamaya veya eşlemeye bağlı değildir.

## 1.0.129 Gönderi ve Reels GraphQL akışı

- Gönderi ve Reels listeleri, Instagram'ın profil sayfasında kullandığı güncel
  GraphQL sorgularından alınır; eski mobil REST yolları kaldırıldı.

## 1.0.128 Minimum ortak hesap eşiği

- Keşif filtresi artık `mutualCount >= expected` kullanır. Örneğin `2`,
  en az iki ortak hesabı olan adayları geçirir; daha yüksek sayılar elenmez.
- Paneldeki açıklamalar da “minimum” eşiği yansıtacak şekilde güncellendi;
  `0` ortak hesap filtresini kapatmaya devam eder.

## 1.0.127 Rastgele kaynak geçişi için panel anahtarı

- Tamamlanan kaynak hesabın ardından rastgele yeni takip edilen hesaba geçiş,
  keşif ayarlarından açılıp kapatılabilir. Varsayılan açıktır; kapatıldığında
  mevcut kaynak tamamlanır ve otomatik keşif durur.

## 1.0.126 Tamamlanan taramadan sonra rastgele takip edilen kaynağa geçiş

- Girilen hesabın takipçileri tamamlanınca giriş hesabının takip ettikleri
  listesinden, daha önce kaynak olarak taranmamış rastgele bir hesap seçilir;
  takipçi taraması mevcut bekleme ve kota ayarlarıyla devam eder.
- Kaynak listesi sayfalı ve kalıcıdır; bir turda en fazla dört takip listesi
  sayfası alınır, sonraki tur cursor'dan devam eder ve kaynaklar tekrarlanmaz.
  Takip edilen kaynak kalmadığında otomatik keşif durur.
- Takip isteği yanıtı belirsizse canlı ilişki kontrolü yapılır. Yalnızca istek
  gönderilmediği doğrulanırsa tek bir ek deneme yapılır; 429, giriş, doğrulama
  veya erişim engellerinde yeniden gönderim yapılmaz.

## 1.0.125 Girilen ortak hesap sayısıyla tam eşleşme

- Ortak hesap alanı artık minimum değil, tam sayı eşleşmesi kullanıyor: 1 yalnızca
  1 ortak hesabı olan adayları; 2 yalnızca 2 ortak hesabı olan adayları geçirir.
- Kural manuel/otomatik taramaya ve dashboard'daki yeniden analiz filtresine
  uygulandı. 0, ortak hesap filtresini kapatır.

## 1.0.124 Mutual sorguları arasında 5 dakika

- `mutual_followers` çağrıları arasında minimum süre 1 dakikadan 5 dakikaya
  çıkarıldı ve son çağrı zamanı hizmet çalışanı yeniden başlasa da korunuyor.
- Bu uç noktanın bekleme süresi genel Instagram istek kuyruğunu tutmuyor; beğeni,
  hikâye ve diğer API işleri sırada beklemeye devam edebiliyor.
- Instagram 429 döndürürse mevcut 30 dakikalık mutual-özel bekleme aynen uygulanır.

## 1.0.123 Profil verisi sayfadan okunur; yüklenmeyen sayaçlar 0 gösterilmez

- Panel sayaçları doğrulanana kadar `…` gösterir; eksik profil yanıtı gerçek
  sıfır takipçi/takip sayısı gibi sunulmaz.
- Profil fallback sekmesi, ek Instagram isteği yapmadan önce sayfanın zaten
  indirdiği kendi profil verisini arar ve `ds_user_id` ile eşleşmesini doğrular.

## 1.0.122 Profil istatistikleri gelmese de doğrulanmış oturumla paneli açma

- `ds_user_id` ile doğrulanan `current_user` kimliği, profil sayıları henüz
  yüklenmemiş olsa da paneli açar; sayaçlar arka planda yenilenir.
- Sonradan gelen tam profil yalnızca aynı oturum kimliğiyle eşleşirse paneli
  günceller; GraphQL profil hatası sonsuz “Bağlanılıyor” ekranında bırakmaz.

## 1.0.121 Takip durumu mutual sorgusundan önce kontrol edilir

- Zaten takip edilen veya istek bekleyen adaylarda mutual_followers çağrısı
  yapılmaz; sınırlı endpoint yalnızca gerçekten takip edilmeyen adaylarda kullanılır.
- Takip durumu doğrulanamazsa keşif güvenli şekilde durur; 429 bekleme süresi
  kısaltılmaz ve yeniden deneme ile aşılmaya çalışılmaz.

## 1.0.120 Beğeni sonrası keşifte aday kontrollerini sırayla tamamlama

- Her aday için önce ortak hesap eşiği, ardından canlı takip durumu ve cinsiyet
  kontrol edilir; takip edilmeyen hedef cinsiyetteki aday için istek denenir.
- Adaylar topluca sınıflandırılmadan önce bütün mutual isteklerinin bitmesi
  beklenmez; bir mutual isteği hata/429 verirse o tur güvenli şekilde durur.
- Keşif hedefi kadın, erkek veya ikisi olduğunda beğeni sonrası akış da aynı
  ayarı kullanır.

## 1.0.119 Eşik değişince otomatik keşfi sürdürme

- Otomatik takip açıkken ortak hesap eşiği değişirse keşif kapanmaz; mevcut
  çalışma aralığı ve Instagram bekleme süreleri korunarak yeni eşikle devam eder.
- Eşik değişikliği kapalı sistemde otomatik tarama başlatmaz.

## 1.0.118 Onaylanan otomatik takipleri dashboard'a kaydetme

- Beğeni sonrası keşif akışı, Instagram yanıtında takip isteği veya takip
  ilişkisinin doğrulanmasının ardından adayı dashboard sonuçlarına ekler.
- Önceki sürümlerde yalnızca takip durumu yerel kayda yazılmış otomatik
  sonuçlar, dashboard'da bu kayıttan yeniden oluşturulur.
- Dashboard, doğrulanmış takip isteği ile takip edilen hesabı ayrı gösterir ve
  onaylanmış geçmiş kayıtlarını ortak hesap filtresi değişse de korur.

## 1.0.115 Saatlik 35 / günlük 840 keşif takip sınırı

- Keşif takip istekleri saatte en fazla 35 ve günde en fazla 840 olacak şekilde
  sınırlandırılır; günlük varsayılan, saatlik sınırın 24 ile çarpımıdır.
- Eski 50/gün varsayılanı bir defa 840'a taşınır; kullanıcı daha düşük bir günlük
  sınır seçtiyse bu değer korunur.
- Bu sayılar uygulamanın güvenlik sınırlarıdır; Instagram saatlik/günlük işlem
  kotası yayımlamamaktadır.

## 1.0.114 Gemini kotasına göre analiz ve 50/gün keşif takibi

- Gemini profilleri beşli gruplarla, dakikada 12 istekten hızlı olmayacak şekilde
  analiz eder; dakika kotası yanıtında bekleyip bir kez yeniden dener.
- Bir gruptan önce alınmış başarılı Gemini sonuçları sonraki bir hata yüzünden silinmez.
- Keşif takip isteği günlük sınırı varsayılan ve üst sınır olarak 50'ye ayarlandı.

## 1.0.113 Gemini 3.5 Flash Lite varsayılanı

- Gemini istekleri varsayılan olarak `gemini-3.5-flash-lite` modeline yönlendirilir.
  `GEMINI_MODEL` ayarıyla model değiştirilebilir.

## 1.0.112 429 hata nedenlerini kaydetme

- Gemini hata kayıtları sağlayıcıyı, modeli, endpoint'i, HTTP kodunu, `Retry-After`
  bilgisini ve varsa kota/yanıt ayrıntılarını kalıcı debug günlüğüne yazar.
- Instagram `429` kayıtları endpoint'i, yanıt nedenini ve varsa `Retry-After`
  başlığını içerir. Aynı sağlayıcı hatasının etkilediği profiller ile benzersiz
  hata sayısı ayrı gösterilir.

## 1.0.111 Gemini 503 için tek yeniden deneme

- Gemini geçici `503` hatasında `Retry-After` başlığını dikkate alarak bekler
  ve isteği bir kez daha dener. Diğer hata kodları otomatik tekrarlanmaz.

## 1.0.110 Ayarlanabilir ortak hesap eşiği

- Ortak hesap aç/kapat anahtarı, manuel ve otomatik taramalarda kullanılan
  sayısal minimum eşik alanına çevrildi.
- `0` değeri ortak hesap şartını kaldırır; eski açık/kapalı ayarlar sırasıyla
  `2` ve `0` eşiklerine taşınır.

## 1.0.109 Gemini API anahtarıyla doğrudan sınıflandırma

- Bu sürümdeki doğrudan Gemini davranışı artık geçerli değildir. Güncel sürümde
  sağlayıcı anahtarı ve AI istekleri yalnızca lisans API sunucusunda bulunur.

## 1.0.107 tamamlanan takipçi taramasında güvenli rastgele profil

- Kaynak hesabın tüm takipçi sayfaları ve o turdaki aday kuyruğu tamamlanınca,
  sayfalar boyunca eşit olasılıklı tek bir rastgele aday seçilir.
- Yalnızca giriş hesabının takip ettiği doğrulanmış adaylar havuza girer.
  Giriş hesabı, kontrol edilen kaynak hesap ve takip durumu canlı kontrolde
  doğrulanamayan hesaplar kesin olarak atlanır.
- Seçilen profil görünür yeni Instagram sekmesinde açılır; mevcut sayfa verisiyle
  kullanıcı adı ve temel profil sayıları doğrulanmaya çalışılır. Takip veya
  beğeni gönderilmez; profil başına ek takipçi listesi taranmaz.
- Tüm liste sayfaları tamamlanmadan seçim yapılmaz; tamamlanan kuyruk için bu
  işlem bir kez çalışır.

## 1.0.106 mutual_followers 429 yanıtını keşifle sınırlama

- Loglarda 429 dönen `mutual_followers` uç noktası için ayrı 30 dakikalık
  bekleme kullanılır; bu yanıt beğeni ve diğer API isteklerini durdurmaz.
- Bekleme hizmet çalışanı yeniden başlasa da korunur; keşif süresi dolunca
  planlı turlarda devam eder.
- 1.0.105'teki global bekleme kaydı, yükseltmede mutual-followers beklemesine
  taşınır; böylece eski genel duraklatma diğer iş akışlarını kilitlemez.

## 1.0.105 Ortak Instagram istek kuyruğu ve 429 beklemesi

- Beğeni, keşif ve otomasyon API istekleri tek bir kuyruktan geçer; istek
  başlangıçları arasında en az 10 saniye bırakılır.
- Instagram 429 döndürürse iki otomasyon da ortak 30 dakikalık beklemeye alınır.
  Bekleme tarayıcı hizmet çalışanı yeniden başlasa da korunur.
- Bekleme süresince yeni Instagram isteği gönderilmez; otomasyonlar kapatılmış
  gibi işaretlenmez ve süre bitince planlı turlarda otomatik devam eder.
- Kullanıcı sistemlerden birini kapatıp tekrar açsa bile aktif bekleme süresi
  korunur.

## 1.0.104 Keşif 429 hatasını ortak otomasyon duraklatmasına aktarma

- Beğeni sonrası keşif sırasında alınan açık 429 yanıtı artık yalnızca keşif
  uyarısı olarak yutulmuyor; ana otomasyon hata işleyicisine aktarılıyor.
- Başarılı beğeni kaydı korunurken otomasyon mevcut bekleme politikasını
  uyguluyor ve yeni otomatik istekleri durduruyor.
- 429 alan istek tekrarlanmıyor; Instagram sınırı atlatılmaya çalışılmıyor.

## 1.0.103 HTML yönlendirme ve profil yenileme yarış düzeltmesi

- Instagram API isteği JSON yerine HTML kabuğuna yönlendirildiğinde, yalnızca
  güvenli salt-okunur liste uç noktaları sayfanın kendi `fetch` bağlamıyla bir
  kez denenir; takip veya beğeni POST istekleri otomatik olarak tekrarlanmaz.
- HTML yanıtı geçici olduğunda yeniden deneme aralığı 15 saniyeden başlayıp en
  fazla 5 dakikaya kadar üstel geri çekilir. Böylece aynı hesabı arka arkaya
  zorlayan retry döngüsü önlenir.
- Takip listesi ve `feed/user/.../username/` istekleri için page-world
  fallback'i eklendi; bu, extension-origin fetch'in HTML shell'e
  yönlendirildiği oturumlarda sayfanın gerçek oturum bağlamını kullanır.
- Profil yenileme istekleri tek uçuşta birleştirildi; panel açılışı, otomatik
  başlangıç ve yenile düğmesi aynı anda çalışınca GraphQL isteği iki kez
  gönderilmez.
- Yakalanan profil GraphQL bağlamının kendi `doc_id` değeri önceliklendirildi;
  farklı bir son GraphQL isteğinin `doc_id` değeriyle değişkenlerin
  eşleşmemesi engellendi.
- Profil fallback yanıtı başarısız olduğunda boş hata yerine tanılayıcı mesaj
  kaydedilir.

## 1.0.102 eski yanlış profil verisinin paneli açmasını engelleme

- Panel açılışında `igUser` önbelleği artık tam profil verisi olarak
  kullanılmıyor; önce oturum hesabı yeniden doğrulanıyor.
- Eski sürümde kaydedilmiş takipçi adı/sayıları panel açılışında gösterilmiyor.
- Yenileme tamamlanana kadar panel yalnızca bağlantı ekranını gösteriyor ve
  yalnızca doğrulanmış `IG_USER_UPDATED` mesajıyla hesabı açıyor.

## 1.0.101 yanlış profilin oturum hesabı olarak gösterilmesi düzeltmesi

- Açık olan takipçi profilinin adı ve sayıları artık oturum hesabının
  `ds_user_id` kimliğiyle birleştirilmiyor.
- Sayfa bootstrap verisi yalnızca oturum kimliğiyle birebir eşleşen kullanıcıyı
  tam profil olarak kabul ediyor.
- GraphQL yanıtındaki profil nesnesinin kendi kimliği oturum kimliğiyle
  eşleşmiyorsa yanıt reddediliyor; takipçi verisi panele yazılmıyor.

## 1.0.100 profil çözümleme 429 ve GraphQL değişken düzeltmesi

- Keşif kaynağı profilini çözmek için `web_profile_info` REST endpoint'i artık
  otomatik olarak çağrılmıyor. Bu endpoint'in art arda 429 üretmesi engellendi.
- Profil çözümleme doğrudan açık Instagram sekmesindeki sayfa verisini ve gerçek
  profil GraphQL akışını kullanıyor.
- Yakalanmış GraphQL değişkenlerindeki tüm olası profil kimliği alanları hedef
  kimlikle güncelleniyor; eski profil kimliğiyle yeni sorgu gönderilmiyor.
- Yakalanan değişkenler eksikse veya `missing_required_variable_value` dönerse
  güncel standart profil değişkenleriyle tek kontrollü fallback deneniyor.

## 1.0.99 gereksiz REST fallback kaldırıldı

- Profil verisi GraphQL veya sayfanın yakaladığı profil verisiyle alınamadığında
  `current_user`/`web_profile_info` REST zinciri artık tekrar denenmiyor.
- Bu endpointler sayfa çalışırken bile uzantı kaynaklı `429` veya `useragent
  mismatch` döndürebildiği için sürekli görünen “30 dakika duraklatıldı”
  hataları kaldırıldı.
- Sonraki fallback doğrudan Instagram profil sekmesinin gerçek GraphQL
  akışını kullanıyor.

## 1.0.98 HAR ile doğrulanan profil GraphQL seçimi

- Instagram profil sayfasında çalışan gerçek `PolarisProfilePageContentQuery`
  çağrısı artık profil sorgusu olarak önceliklendirilir.
- Not balonu, hikâye öne çıkanları, önerilen kullanıcılar, okul rozeti ve
  gönderi sorguları profil sorgusuyla karıştırılmaz.
- HAR'da görülen `data.user` yanıt biçimi ve `for (;;);` ön eki desteklenir.
- Böylece yardımcı GraphQL çağrısından yanlış `doc_id` alınarak sürekli
  `user_dict boş` hatası üretilmesi engellenir.

## 1.0.97 yanlış genel rate-limit kilidi düzeltmesi

- Profil yenilemesindeki tek bir `429` yanıtı artık tüm liste ve otomasyon
  isteklerini 30 dakika kilitlemiyor.
- Eski sürümlerde depolanan genel cooldown kurulurken temizleniyor.
- Profil isteği başarısız olsa bile takipçi/takip edilen listeleri kendi akışıyla
  devam edebiliyor; gerçek sunucu hatası yalnızca ilgili isteğe yansıyor.

## 1.0.96 takipçi/takip sayılarında yuvarlama düzeltmesi

- Profil kartındaki sayılar artık `2.0K` gibi tek ondalığa yuvarlanmıyor.
- Takipçi, takip edilen ve gönderi sayıları tam değerleriyle ve Türkçe sayı
  biçiminde gösteriliyor; böylece birbirine yakın iki farklı sayı aynı
  görünmüyor.

## 1.0.87 panel açılışını GraphQL'den ayırma

- Panel açılışı artık profil GraphQL operasyonunun yakalanmasını beklemiyor.
- `igUser` önbelleği veya `ds_user_id` cookie mevcutsa minimal kullanıcı kimliği
  ile panel hemen açılıyor; profil adı ve sayılar daha sonra güncellenebilir.
- `current_user` REST ve yakalanmamış GraphQL nedeniyle oluşan açılış döngüsü
  kaldırıldı.

## 1.0.86 temiz panel kurulumu

- Panel, popup içindeki `chrome.runtime.getURL('panel.html')` akışıyla
  açılır; `panel.js`, `popup.js`, `background.js` ve manifest sözdizimi
  doğrulanmıştır.
- Eski Service Worker kayıtlarının yeni kodla karışmaması için bu sürüm
  yeni bir manifest sürümüyle paketlenmiştir.
- Kurulumda önce eski Takipçi Paneli uzantısı kaldırılmalı, ZIP çıkarıldıktan
  sonra yalnızca manifest.json bulunan klasör yüklenmelidir.

## 1.0.85 content-script current_user çağrısı kaldırıldı

- Content script artık `accounts/current_user/?edit=true` endpoint'ini
  denemiyor; bu endpoint'in verdiği `useragent mismatch` hatası tekrar
  üretilmiyor.
- Oturum açmış kullanıcı için önce yakalanmış profil GraphQL sonucu, sonra
  `ds_user_id` ile doğrulanan sayfa bootstrap verisi kullanılıyor.

## 1.0.84 current_user REST yolu devre dışı

- Instagram'ın `accounts/current_user/?edit=true` endpoint'i bu oturumlarda
  `HTTP 400: useragent mismatch` verdiği için artık tekrar tekrar çağrılmıyor.
- Kullanıcı bilgisi önce oturum çerezindeki `ds_user_id` ile doğrulanmış
  `igUser` önbelleğinden, yoksa yakalanmış profil GraphQL operasyonundan
  alınıyor.
- Böylece her yenilemede aynı 400 hatasının üretilmesi ve gereksiz REST/
  GraphQL zinciri engelleniyor.

## 1.0.83 useragent mismatch düzeltmesi

- `current_user` REST çağrısı artık sayfanın MAIN-world `fetch` fonksiyonu
  üzerinden yapılabiliyor; böylece uzantı izole bağlamının oluşturduğu
  `useragent mismatch` reddi aşılmadan gerçek sayfa isteği taklit ediliyor.
- Content script ile MAIN-world köprüsü arasında istek/yanıt kimliği olan,
  yalnızca `accounts/current_user` endpoint'ine izin veren bir el sıkışma
  eklendi.
- Köprü kullanılamazsa v1.0.82'deki executeScript fallback'ı korunuyor.

## 1.0.82 current_user REST bağlamı düzeltmesi

- `accounts/current_user/?edit=true` isteği artık önce Instagram sayfasında
  çalışan content script üzerinden gönderiliyor; `executeScript` bağlamı yalnızca
  ikinci REST fallback olarak kullanılıyor.
- REST başarısız olursa log kaydında kullanılan kaynak ve gerçek hata metni
  korunuyor.
- Service Worker konsolundaki tanı kayıtları artık kapalı `Object` yerine
  JSON olarak okunabiliyor.

## 1.0.81 GraphQL profil yakalama sağlamlaştırması

- `fetch(new Request(...))` biçimindeki GraphQL çağrılarında Request gövdesi
  artık klonlanarak okunuyor; Instagram'ın gönderdiği asıl Request tüketilmiyor.
- Profil operasyonu için `docId`, `query_id`, `queryId` ve `operationName`
  varyantları hem MAIN-world köprüsünde hem `webRequest` yedeğinde tanınıyor.
- Profil tespiti yeni operasyon adlarında yalnızca `PolarisProfilePageContent`
  adına bağlı değil; profil/user-info sinyali ve kimlik değişkenleri birlikte
  değerlendiriliyor. Takipçi/takip edilen liste sorguları profil olarak
  işaretlenmiyor.

## 1.0.80 REST önceliği ve geniş profil tespiti

- Oturum açmış kullanıcı verisi için önce Instagram'ın
  `/api/v1/accounts/current_user/?edit=true` REST endpoint'i deneniyor.
- Profil GraphQL operasyonu yalnızca REST başarısız olduğunda yedek yol olarak
  kullanılıyor; bu nedenle GraphQL operasyonu yakalanmamış sayfalarda gereksiz
  bağlantı hatası gösterilmiyor.
- Yeni Instagram sürümlerinde `enable_integrity_filters` olmadan gelen profil
  sorguları da kimlik değişkeni ve profil sayfası bağlamıyla tanınıyor.

## 1.0.79 URL tabanlı GraphQL yakalama

- Profil sorgusu `GET` olarak veya URL query parametreleriyle gönderildiğinde
  `doc_id`, operasyon adı ve `variables` artık yakalanıyor.
- `webRequest` dinleyicisi artık GraphQL `GET` isteklerini de izliyor.

## 1.0.78 Profil GraphQL yakalama düzeltmesi

- Profil GraphQL isteği artık `fetch`/`XMLHttpRequest` gönderildiği anda MAIN
  world köprüsünden yakalanıyor; yalnızca `webRequest` gövdesine güvenilmiyor.
- JSON ve form gövdelerindeki `doc_id`, `friendly_name` ve `variables` alanları
  saklanıyor.
- Profil operasyon adı değişse bile `PolarisProfilePageQuery` ve yakalanan
  profil değişkenleri destekleniyor.
- `document_start` ile `document_idle` arasındaki zaman farkı için son yakalanan
  istek DOM handoff üzerinden tekrar gönderiliyor.

## 1.0.77 Genderize.io entegrasyonu

- Genderize.io, isim/kullanıcı adı tahmini için birincil sağlayıcı olarak eklendi.
- 10 isme kadar batch istek, `TR` ülke modeli ve güven eşiği desteği eklendi.
- API yanıtı yoksa veya olasılık düşükse sonuç **Belirsiz** olarak saklanıyor.
- Profil fotoğrafı Genderize.io'ya gönderilmiyor.

## 1.0.76 cinsiyet analiz düzeltmesi

- Dashboard artık `env.js` ayarını gerçekten yüklediği için Mistral/AI
  sağlayıcısı varken kayıtları yanlışlıkla **Belirsiz** göstermiyor.
- Mistral ve proxy yanıtları; JSON dizi, tek nesne, `results`/`data` ve
  görsel modelin parça parça `message.content` biçimleriyle uyumlu hale
  getirildi.
- Her kullanıcı artık ayrı bir Mistral/proxy isteğinde gönderiliyor; 77
  hesabın tek bir istekte karışması engelleniyor.
- Mistral görsel isteğinde `image_url` artık dokümantasyondaki string
  biçiminde gönderiliyor; hatalı OpenAI biçimi olan `{ url: ... }` kaldırıldı.
- Güncel organizasyon limitlerinde bulunan `mistral-small-2603` modeli
  seçildi; `mistral-small-2506` artık kullanılmıyor. 1 istek/saniye sınırına
  uymak için profil istekleri arasında 1,1 saniye bekleniyor.
- HTTP hata yanıtı, status, retry-after, seçilen model, kullanıcı adı ve
  Mistral'ın döndürdüğü gövde artık Service Worker Console'da açıkça
  gösteriliyor. API anahtarı ve görsel verisi loglanmıyor.
- Geçici Mistral `429` veya ağ hatasında belirgin isim/bio sinyali tamamen
  kaybolmuyor; kayıt sonraki analizde AI'ya yeniden gönderilmek üzere
  işaretleniyor.
- Bu sürümdeki eski doğrudan Mistral yapılandırması artık desteklenmez. Güncel
  sağlayıcı anahtarını yalnızca `self-hosted-api/.env` dosyasındaki sunucuya
  girin; uzantıya veya dağıtım paketine eklemeyin.

## 1.0.70 Mistral belirsiz sonuç ve çoklu fotoğraf düzeltmesi

- Çok sayıda profil ve fotoğraf tek istekte gönderilmiyor; görsel ile kullanıcı
  adı eşleşmesinin bozulmaması için Mistral istekleri en fazla 6 profillik
  gruplara ayrılıyor.
- Mistral biyografi boş olduğu için `unknown` döndürse bile kullanıcı adı ve
  görünen ad için güvenli yerel sinyaller tekrar uygulanıyor. Böylece `nika`,
  `zoya`, `anastasia`, `svitlana`, `tuğçe`, `dilara` gibi açık ad sinyalleri
  kadın sonucunu kaybetmiyor.
- Instagram'ın kalın/italik Unicode yazı tipleri normalleştiriliyor; örneğin
  `𝐃𝐢𝐥𝐚𝐫𝐚` artık `Dilara` olarak tanınabiliyor.
- AI istemi boş biyografiyi otomatik olarak `unknown` saymaması ve her profili
  bağımsız değerlendirmesi için sıkılaştırıldı.

## 1.0.69 kullanıcı adı ve profil fotoğrafı analizi

- Cinsiyet analizi artık yalnızca biyografi/metinle sınırlı değildir; kullanıcı adı,
  görünen ad ve mevcut profil fotoğrafı da aynı değerlendirmeye gönderilir.
- Takip listesi ve keşif normalizasyonunda profil fotoğrafı URL'si artık kaybolmaz;
  bu nedenle Dashboard'da fotoğraf mevcutken "fotoğraf yok" görünmesi düzeltilmiştir.
- Mistral doğrudan bağlantısında görsel destekli `pixtral-large-latest` modeli kullanılır.
  Özel AI sunucularına da `profile_pic_url` ve `profile_pic_url_hd` alanları iletilir.

## 1.0.68 Dashboard manuel analiz butonu

- `Çekilen Hesaplar` kartına `♀ Manuel analiz` butonu eklendi.
- Buton, Dashboard’da görünür olan ve en az 2 ortak hesabı bulunan adayları
  zorunlu cinsiyet analizine alır.
- Kadın çıkan adaylarda mevcut tekrar takip, kaynak hesap, kota ve güvenlik
  kontrolleri korunarak takip isteği gönderilir.
- Sağlayıcı yoksa analiz durdurulur; hesaplar Belirsiz bırakılır.

## 1.0.67 mutual kontrolü profil analizinden önce

- Beğeni sonrası keşif akışında aday profili/cinsiyet analizi yapılmadan önce
  adayın `mutual_followers` sayısı kontrol edilir.
- 2'den az ortak hesabı olan adaylar cinsiyet analizine ve takip isteği
  akışına hiç alınmaz.
- Yalnızca `mutualCount >= 2` olan daraltılmış aday listesi AI sağlayıcısına
  gönderilir; böylece gereksiz AI/API kotası kullanılmaz.

## 1.0.66 Dashboard kartları için mutual filtresi

- Keşif kuyruğundaki henüz kontrol edilmemiş takipçiler Dashboard'a kart olarak
  aktarılmaz.
- Dashboard'da yalnızca `mutualCount >= 2` olan adaylar gösterilir.
- İki ortak hesap şartını geçmeyen adaylar yalnızca arka plan kuyruğunda
  elenir; cinsiyet analizi ve takip isteği akışına alınmaz.
- Dashboard yeniden analiz düğmesi de yalnızca bu şartı geçmiş kartları işler.

## 1.0.65 sağlayıcı yokken Dashboard etiket koruması

- Lisans sunucusu adresi yokken Dashboard keşif kartları da
  mevcut eski cinsiyet etiketlerini kullanmayıp **Belirsiz** görünür.
- Kadın kartı filtresi ve otomatik takip akışı sağlayıcı eklenene kadar hiçbir
  eski etiket üzerinden takip isteği başlatmaz.

## 1.0.64 AI sağlayıcısı olmadan cinsiyet kontrolünü durdurma

- Lisans sunucusu adresi yoksa otomatik keşif artık cinsiyet
  sınıflandırması yapmaz.
- Bu durumda adaylar yalnızca Dashboard'da **Belirsiz** görünür; yerel isim/
  biyografi fallback'i otomatik takip akışında kullanılmaz.
- Dashboard'daki yeniden analiz düğmesi de AI sağlayıcısı yoksa çalışmayı
  reddeder ve kartları Belirsiz bırakır.
- Sağlayıcı eklendiğinde düğme yalnızca Dashboard'da görünen otomatik ve
  manuel keşif kartlarını yeniden analiz eder; kadın sonuçlarında mevcut ortak
  hesap, kota ve daha önce gönderilmiş istek kontrolleri korunur.

## 1.0.63 hedef kullanıcı adı değişikliği

- Hedef kullanıcı adı yazılırken arka plan keşif durumunun input'u eski
  kullanıcı adıyla ezmesi engellendi.
- Açık takip akışında kullanıcı adı değişince yeni profil otomatik doğrulanır
  ve geçerli ise kaynak hesap atomik olarak güncellenir.
- Yeni profil doğrulaması geçici olarak başarısız olursa mevcut çalışan
  kaynak hesap otomatik olarak kapatılmaz.

## 1.0.62 eski Belirsiz kayıtları yeniden analiz etme

- Dashboard'a **Belirsiz Cinsiyet Kayıtları** bölümü ve yeniden analiz düğmesi
  eklendi.
- Düğme, eski kayıtları zorunlu yeniden sınıflandırır; kadın çıkan adaylarda
  önce ortak hesap şartını ve takip güvenlik kontrollerini uygular, ardından
  uygun adaya takip isteği gönderir.
- Sonuçlar otomatik keşif, manuel keşif ve eski önbellek kayıtlarına geri
  yazılır. Günlük takip kotası ve daha önce gönderilmiş istek kontrolü korunur.
- Bir çalıştırmada en fazla 100 eski kayıt işlenir; kalanlar sonraki düğme
  tıklamasında ele alınabilir.

## 1.0.61 cinsiyet sınıflandırma düzeltmesi

- AI yanıtındaki `id`/`username` farklılıkları artık eşleşmeyi bozmaz; etiket
  adayın hem Instagram ID'sine hem de kullanıcı adına kaydedilir.
- Eski `Belirsiz` sonuçları kalıcı değildir; yeni taramada tekrar denenir.
- API yanıtı eksik veya çözümlenemediğinde açık profil metni, kullanıcı adı ve
  yaygın ad sinyalleriyle yerel geri dönüş çalışır. Görsel değerlendirme için
  sağlayıcı görsel destekli olmalıdır.
- Instagram listesinin taşıdığı eski `gender: unknown` değeri, kayıtlı ve
  doğrulanmış bir kadın etiketinin üzerine yazamaz.

## 1.0.60 düzeltmeleri

- **Beğeni sistemi** ile **Takip isteği sistemi** ayrı anahtarlardır. İki sistem
  aynı anda açık olduğunda kendi akışlarında çalışır; Instagram istekleri ortak
  güvenlik kuyruğunda sıraya alınır.
- Ayarlar ekranında iki sistemin durumları ayrı ayrı gösterilir.
- Otomatik takip seçeneği varsayılan olarak kapalıdır. Liste çekme işlemi,
  kullanıcı açıkça etkinleştirmedikçe otomatik takip kuyruğu başlatmaz.

- Hesap kartı flex yerleşiminde 0 yüksekliğe sıkışmasın diye kart ve grid
  küçültülemez hale getirildi; grid görünürlüğü de çalışma anında sabitlenir.

- Hesaplar sekmesine geçildiğinde dashboard kaydırması başa alınır; kartlar
  görünür alana taşınır.

- `◎ Hesaplar` sekmesi, veri yükleme ve React overlay yerleşimiyle yarışsa bile
  hesap kartlarını görünür tutar; sekme tıklaması olay delegasyonu ile güvenli
  şekilde işlenir.

- Keşif akışı, panelde yazılan hesabın takipçi listesini sayfalı olarak alır ve
  adayları tek tek işler. Her takipçi adayı için önce adayın Instagram'da
  gösterilen ortak hesap sayısı (`mutual_followers`) kontrol edilir. En az 2
  ortak hesap yoksa o aday sınıflandırılmaz ve takip isteği gönderilmez.
- Instagram'ın güncel takip isteği uç noktası (`friendships/create`) ve HAR'da
  görülen `fb_dtsg`/`jazoest` alanları kullanılır.
- En az 2 ortak hesap varsa yalnızca o takipçi adayının profil metni
  sınıflandırılır; yalnızca `Kadın` sonucu takip isteği alır. `Erkek` ve
  `Belirsiz` sonuçlar atlanır.
- Daha önce takip edilenler, takip isteği gönderilenler ve keşif sırasında
  taraması tamamlanan adaylar `__discovery_history_v1` içinde tutulur. Aynı
  hedef kullanıcı yeniden yazıldığında aynı aday için tekrar ortak hesap veya
  AI isteği yapılmaz.
- Instagram istek sınırı veya otomasyon durumu mesajı hedef kullanıcı ve takip
  sistemi kartında gösterilir.
- Beğeni ve takip isteği sistemleri aynı anda açıksa, beğeni atılan hesabın
  `Takip ettikleri` listesi alınır. Bu listedeki adaylar önce kadın/erkek
  olarak sınıflandırılır; kadın adayın profilinde en az 2 ortak hesap varsa
  ilk uygun adaya takip isteği gönderilir.

- Rate-limit cooldown artık arka plan ve content-script arasında aynı,
  hesap-kapsamlı formatta saklanır.
- Eski sürümün çıplak timestamp değeri yalnızca mevcut Instagram oturumuna
  bağlanarak bir kez migrate edilir; cooldown atlatılmaz.
- Manuel liste istekleri de ortak istek kuyruğundan geçer, böylece profil
  çözümleme ve liste çekme çağrıları aynı hız sınırını paylaşır.
- Manuel istekler HAR'daki tarayıcı isteğine daha yakın Instagram başlıkları
  (ASBD, touch-points ve mevcut `x-ig-www-claim`) ile gönderilir.
- Instagram web arayüzünde istek çalışırken yalnızca uzantının eski yerel
  cooldown kaydı kalmışsa, Ayarlar'daki açık kullanıcı eylemiyle bu kayıt
  temizlenip tek bir yeniden deneme yapılabilir. Gerçek bir 429 gelirse kilit
  yeniden oluşturulur.
- Kaynak kullanıcı adı çözümleme artık `web_profile_info` endpoint'ine
  güvenmek yerine Instagram'ın açık profil sayfasındaki gerçek sayfa verisini
  kullanır. Böylece profil lookup'ın HTML/geçici yanıt hatası manuel taramayı
  durdurmaz.
- Profil yanıtı content script başlamadan önce geldiyse, kaynak kullanıcı
  çözümleme artık Instagram'ın inline başlangıç JSON verisini de tarar.

Instagram tarayıcı uzantısı. Takipçi ve takip edilen listeleri çekildiğinde
profil metnini güvenli bir eşikle sınıflandırır:

- `Erkek`
- `Kadın`
- `Belirsiz`

Kullanıcı adı, görünen ad, biyografi ve mevcut profil fotoğrafı birlikte
değerlendirilir. Yeterli sinyal yoksa sonuç bilinçli olarak `Belirsiz` kalır.

## Cinsiyet sağlayıcısını seçme

Gemini/Mistral sağlayıcısı ve modeli `self-hosted-api/.env` dosyasında seçilir.
`GEMINI_API_KEY` veya `MISTRAL_API_KEY` yalnızca lisans API sunucusunda
bulunmalıdır. Tarayıcı eklentisi, etkin lisansla bu sunucuya istek gönderir;
sağlayıcıya doğrudan bağlanmaz. Bu anahtarları `extension-work/env.js` dosyasına
veya kullanıcılara dağıtılan eklenti klasörüne koymayın.

## Ortak hesap ve otomatik takip

Ayarlar bölümünde hedef kullanıcı adı ve `Takip isteği sistemini aç / kapat`
anahtarı ayrı tutulur. Beğeni sistemi kapalıysa yazılan profilin
`mutual_followers` sonucu kontrol edilir. Beğeni sistemi de açıksa hedef
kullanıcı adı yerine az önce beğeni atılan hesabın takip ettikleri taranır.
Manuel ve otomatik taramalarda Ayarlar'daki minimum ortak hesap sayısı kullanılır.
Örneğin `2`, en az 2 ortak hesabı olan adayları geçirir. `0` girildiğinde ortak
hesap filtresi uygulanmaz.

Beğeni ve takip isteği otomasyonu ayrı anahtarlarla açılıp kapanır.