# drag-and-drop-preview-images-module

Зона перетягування зображень із попереднім переглядом: фронтенд-віджет без залежностей
і серверний обробник завантаження без фреймворка.

Киньте на неї файли або виберіть їх звичним способом — кожен з'явиться мініатюрою
з розміром і кнопкою, щоб прибрати його назад. Зображення заповнюються по черзі, у міру
декодування, тож велика вибірка показує першу мініатюру одразу, а не сітку порожніх
квадратів. Без серверної адреси віджет лишається звичайним полем форми: файли їдуть
разом із формою, і бекенд не бачить різниці. Дайте адресу — і він надсилає їх сам,
зі смугою поступу та робочою кнопкою скасування.

Про що він дбає:

- **Файл — це те, що кажуть його байти.** Ім'я й тип, які повідомляє браузер, — це
  здогад операційної системи за розширенням; перейменувати виконуваний файл на `.png`
  достатньо, щоб обдурити обидва. Обидві половини читають натомість перші байти.
  Перевірка на клієнті існує, щоб пояснити причину користувачеві; вирішує серверна, бо
  все, що доступне через HTTP, можна надіслати curl-ом узагалі без браузера.
- **Сервер відхиляє імена, а не виправляє їх.** Вихід за межі теки в будь-якому
  написанні, нульові байти, зарезервовані імена Windows, крапки в кінці — ім'я, яке
  доводиться переписувати, щоб зробити безпечним, зазвичай належить спробі зламу.
- **Нічого недописаного не лишається.** Кожне завантаження йде під тимчасовим іменем
  і перейменовується, лише коли файл цілий, а обірваний запит прибирається за собою,
  замість лишати сміття на диску.
- **Форма з чужого сайту не може надіслати в цю адресу.** `multipart/form-data` не
  проходить preflight, тож без перевірки Origin будь-яка сторінка будь-якого сайту
  могла б завантажити файл під сесійною кукою користувача.

Розмір і будова: 13 КБ JS і 2 КБ CSS у gzip на сторінці, нуль runtime-залежностей.
Серверна половина — одна функція `(req, res)`, яка монтується в Express, AdonisJS,
Fastify, Nest або голий `node:http`, і має єдину залежність — парсер multipart. Із нею
йдуть п'ять мов: англійська (типова), українська, іспанська, німецька й французька, —
а також світла й темна теми, де кольори, шрифти й розміри задаються під час підключення.

> 🇬🇧 [This page in English](README.md) — головна версія документації.

---

## Стан

У роботі, на npm поки не опубліковано. Доки цього не сталося, встановлюйте
з репозиторію:

```bash
npm install github:Insider515/drag-and-drop-preview-images-module
```

Або склонуйте й запустіть демо:

```bash
git clone https://github.com/Insider515/drag-and-drop-preview-images-module.git
cd drag-and-drop-preview-images-module
npm install
npm start          # збирає демо й піднімає його на http://127.0.0.1:5173
```

---

## Швидкий старт

### Як поле форми — без жодних змін на сервері

Не задавайте `endpoint` — і віджет лишиться тим, що замінив: `<input type="file">` із
попереднім переглядом. Файли йдуть разом із формою, і ваш наявний бекенд не помітить
різниці.

```html
<form action="/contact" method="post" enctype="multipart/form-data">
  <div id="images"></div>
  <button type="submit">Send</button>
</form>
```

```js
import { DropPreview } from 'drag-and-drop-preview-images-module';
import 'drag-and-drop-preview-images-module/style.css';

new DropPreview('#images', { name: 'images[]' });
```

### Самостійне завантаження

```js
const drop = new DropPreview('#images', {
  endpoint: '/api/upload',
  autoUpload: true,
});

drop.on('uploaded', ({ answer }) => console.log(answer.uploaded));
```

```js
// server
import express from 'express';
import { createUploadHandler } from 'drag-and-drop-preview-images-module/server';

const app = express();
app.use('/api/upload', createUploadHandler({ root: './uploads' }));
app.listen(3000);
```

---

## Що вміє

| | |
| --- | --- |
| Перегляд | Мініатюри з самих файлів, з іменем і розміром |
| Вибіркове видалення | У кожної плитки своя кнопка; «Видалити все» очищає чергу |
| Перетягування | У зону, з підсвіткою, що не блимає, коли курсор перетинає вкладені елементи |
| Розпізнавання | Тип читається з перших байтів файлу, ніколи з розширення |
| Обмеження | На файл, на чергу, на кількість і на декодовані пікселі |
| Завантаження | Поступ і скасування — або нічого, якщо лишити полем форми |
| Мови | П'ять готових; своя — це об'єкт зі словником |
| Теми | Світла й темна, за системою або примусово; кожен колір — CSS-змінна |
| Два на сторінці | Нічого не реєструється глобально, екземпляри не заважають один одному |

---

## Опції віджета

```js
new DropPreview(target, {
  endpoint: null,         // POST here; null keeps it a plain form field
  name: 'images[]',       // form field name
  fields: null,           // extra form fields sent with an upload
  headers: null,          // object or function — for authorisation tokens
  credentials: 'same-origin',

  accept: [],             // MIME types; empty means every image format known
  allowSvg: false,        // SVG is XML that can carry script; opt-in
  limits: null,           // see below

  autoUpload: false,      // upload as soon as files are chosen
  showUploadButton: true,
  showClearButton: true,

  locale: null,           // 'en' | 'uk' | 'es' | 'de' | 'fr' | your dictionary
  theme: null,            // colours, fonts, metrics
  colorScheme: 'auto',    // 'auto' | 'light' | 'dark'
});
```

`target` — елемент або CSS-селектор.

### Обмеження

```js
new DropPreview('#images', {
  limits: {
    maxFileSize: 10 * 1024 * 1024,   // bytes per file
    maxFiles: 20,                    // files in the queue
    maxTotalSize: 100 * 1024 * 1024, // bytes for the whole queue
    maxPixels: 50 * 1024 * 1024,     // pixels a preview may decode
  },
});
```

`maxPixels` — не про охайність. PNG на 30 КБ може оголосити 40000×40000 і коштувати
кілька гігабайтів після декодування — вкладка помре ще до будь-якого завантаження.
Розміри відомі лише після того, як браузер розібрав заголовок, тому перевірка
відбувається під час побудови перегляду, і файл поза межею відкидається з поясненням.

### Методи й події

```js
await drop.add(fileList);        // same checks as picking them by hand
drop.remove(id);
drop.clear();
await drop.upload();
drop.cancel();
drop.destroy();

drop.files;                      // the queue, as plain objects
drop.totalBytes;
drop.busy;

drop.on('change',   ({ files }) => {});
drop.on('rejected', ({ rejected }) => {});   // [{ file, code, detail }]
drop.on('uploaded', ({ answer, files }) => {});
drop.on('error',    ({ error, code, message }) => {});
```

`on()` повертає функцію відписки.

Відмова несе `code`, а не речення, — на ньому можна розгалужуватись. Щоб показати її
людині, `drop.describeError(code, detail)` перетворює код на текст активною мовою.

---

## Мова

```js
new DropPreview('#images', { locale: 'de' });
```

Приймається `'en'`, `'uk'`, `'es'`, `'de'`, `'fr'` або повний тег, чия основа збігається
з однією з них: `'de-AT'` дасть німецьку. Нерозпізнане значення дає англійську, а не
помилку.

Множина рахується за правилом мови — українська має три форми, решта дві — а одиниці
розміру стають місцевими (`1.5 Ko` у французькій). На корені віджета проставляється
атрибут `lang`.

### Своя мова

Неповний словник — нормально: усе, чого в ньому немає, береться з англійської.

```js
import { DropPreview, PLURAL_RULES } from 'drag-and-drop-preview-images-module';

new DropPreview('#images', {
  locale: {
    id: 'sv',
    name: 'Svenska',
    tag: 'sv',
    plural: PLURAL_RULES.default,
    strings: {
      'drop.button': 'Välj filer',
      'drop.hint': 'eller dra dem hit',
      'count.files': { one: '{n} fil', other: '{n} filer' },
    },
  },
});
```

Готові словники — звичайні експорти (`import { en, uk } from '…'`), а в репозиторії
лежать у `src/locales/` — по одному простому об'єкту на мову. Тест стежить, щоб набір
ключів у всіх п'яти збігався, і відхиляє переклад, у якому з'явився підстановник, якого
немає в англійській.

---

## Оформлення

Нічого не передали — віджет виглядає так, як у демонстрації.

```js
new DropPreview('#images', {
  colorScheme: 'auto',      // 'auto' follows the system; 'light'/'dark' force it
  theme: {
    font: "'Inter', system-ui, sans-serif",
    fontSize: '15px',
    radius: '2px',
    tileSize: '140px',
    gap: '16px',
    dropHeight: '160px',

    colors: { accent: '#7c3aed', accentHover: '#6d28d9' },
    light: { bg: '#fffdf7', text: '#2b2415' },
    dark: { bg: '#0b1020', accent: '#a78bfa' },
  },
});
```

`colors` діє в обох схемах, `light` і `dark` його уточнюють. Оформите лише світлу — темна
лишиться з вбудованими кольорами, і світлий фон уночі не з'явиться.

**Кольори:** `bg`, `bgSubtle`, `bgSunken`, `border`, `borderStrong`, `text`, `textMuted`,
`accent`, `accentHover`, `accentSoft`, `accentContrast`, `danger`, `dangerHover`,
`success`, `warning`, `shadow`, `overlay`.

**Шрифти й розміри:** `font`, `fontSize`, `radius`, `radiusLarge`, `tileSize`, `gap`,
`dropHeight`.

Невідомий ключ кидає помилку, а не ігнорується. Ключ, що починається з `--`, проходить
наскрізь — для змінної, якої в переліку ще немає. Значення перевіряються: те, що могло б
закрити правило й відкрити своє (`;`, `}`, `url(`, коментарі), відхиляється — це важить,
якщо кольори у вас приходять від ваших користувачів.

Тема діє на один віджет, тож два на сторінці можуть виглядати по-різному.

---

## Куди можна змонтувати сервер

`createUploadHandler()` повертає звичайну функцію `(req, res)` над власними об'єктами
Node. `basePath` — префікс, який треба відрізати, коли хост не переписує `req.url` сам:
Express переписує, Adonis і `node:http` — ні.

```js
// Express
app.use('/api/upload', createUploadHandler({ root: './uploads' }))

// AdonisJS
const files = createUploadHandler({ root: app.makePath('uploads'), basePath: '/api/upload' })
router.any('/api/upload/*', ({ request, response }) => files(request.request, response.response))

// Fastify
fastify.all('/api/upload/*', (req, reply) => files(req.raw, reply.raw))

// bare node:http
http.createServer(files).listen(3000)
```

### Опції обробника

```js
createUploadHandler({
  root: './uploads',        // required; the one directory files may land in
  basePath: '',             // prefix to strip from the URL
  field: 'images[]',        // поле форми, яке читати — типове для віджета

  accept: [],               // MIME types; empty means every image format known
  allowSvg: false,
  onConflict: 'rename',     // 'rename' | 'refuse' | 'overwrite'
  rename: null,             // (name, { type }) => string — choose the stored name

  limits: {
    maxFileSize: 10 * 1024 * 1024,
    maxFiles: 20,
    maxRequestSize: 100 * 1024 * 1024,
    minFreeSpace: 64 * 1024 * 1024,
  },
  maxConcurrent: 8,         // uploads in flight; beyond that, 503

  allowedOrigins: undefined, // same-origin only by default; false disables the check
  authorize: (req, ctx) => true,
  onWarning: (message, detail) => {},
});
```

### Що повертається

```json
{
  "uploaded": [{ "name": "photo.png", "original": "photo.png", "size": 1024, "type": "image/png" }],
  "failures": [{ "name": "evil.png", "code": "NOT_AN_IMAGE", "error": "…", "params": null }],
  "fields": { "album": "holiday" }
}
```

Один поганий файл не валить пакет. Клієнту повідомляють, які не пройшли і чому, а решта
лишається.

### Тільки частина, що зберігає

`UploadService` робить роботу з файловою системою і нічого не знає про HTTP — для
фреймворка, який розбирає multipart сам:

```js
import { UploadService } from 'drag-and-drop-preview-images-module/server';

const service = new UploadService({ root: './uploads' });
const stored = await service.store(filename, readableStream);
```

---

## Безпека

Наскрізний принцип: **вирішують власні байти файлу, і сервер вирішує ще раз.**

**Розпізнавання.** `File.type` браузер бере з відповідності розширень в операційній
системі, тож перейменувати `payload.exe` на `photo.png` достатньо, щоб він назвався
`image/png`. Обидві сторони натомість читають перші байти. Клієнтська копія існує, щоб
пояснити людині причину; сервера — щоб мати вагу, бо все, що досяжне по HTTP, можна
надіслати curl і взагалі без браузера.

**SVG — лише за запитом.** Це єдиний формат зображення, який є XML і може нести скрипт.
Решта приймається за замовчуванням; цей треба попросити окремо.

**Імена.** Відхиляти, а не лагодити. Вихід за межі в будь-якому написанні, нульові байти,
символи, щодо яких файлові системи не згодні, кінцеві крапки й пробіли, зарезервовані
імена Windows — усе це відхиляється, а не переписується: ім'я, яке треба переписати, щоб
воно стало безпечним, зазвичай належить спробі. Шлях із завантаження теки вкорочується до
останнього сегмента ще до всього цього.

**Утримання в межах.** Куди потрапить файл, перевіряється двічі: лексично й проти
розв'язаного кореня. Жодної з перевірок окремо не досить — друга ловить символьне
посилання, підкладене в теку завантажень і скероване на `/etc`.

**Запис.** Кожен файл іде під тимчасовим іменем і перейменовується лише після успіху, тож
обірване завантаження не лишає обрізаного файлу під справжнім іменем. Остаточне ім'я
займається через `O_EXCL`, тож «чи вільне» і «зайняти» — одна операція; інакше два запити
з однаковим іменем пройшли б перевірку обидва, і один файл зник би.

**Міждоменні запити.** `multipart/form-data` — *простий* запит: preflight для нього не
робиться, тож звичайна `<form>` на будь-якому сайті могла б відправити сюди файли під
сесійною cookie користувача. Перевірка Origin це закриває. Запит зовсім без браузерних
заголовків — curl, виклик між серверами — пропускається.

**Обмеження** рахуються за фактично отриманими байтами, а не за `Content-Length` — це
твердження відправника, а в chunked-запиті його немає взагалі.

**У DOM.** Нічого не збирається конкатенацією рядків в `innerHTML`; у помічника, яким
користується віджет, такої лазівки немає. Файл на ім'я `<img src=x onerror=alert(1)>.png`
малюється як цей текст і більше ніяк.

### Чого він не робить

- Не автентифікує і не обмежує частоту запитів — і те, й інше ставиться перед ним.
- Не перевіряє на віруси. «Це справжнє зображення» — не те саме, що «це безпечне зображення».
- Не обробляє зображення: нічого не перекодовується, не масштабується і не очищається від
  метаданих. EXIF, включно з координатами GPS, зберігається як прийшов.
- `server/standalone.js` — сервер для розробки без жодної автентифікації. Він не входить
  до npm-пакета.

---

## Розробка

```bash
npm install
npm run dev          # API + Vite з гарячим перезавантаженням -> http://localhost:5173
npm test             # 116 тестів
npm run build        # бібліотека -> dist/
npm run build:demo   # демо-сторінка -> demo-dist/
npm start            # зібрати демо і віддати без Vite
```

Параметри сервера розробки: `--port`, `--host`, `--root`, `--svg`, `--vite`.

### Структура

```
src/                the widget
  drop-preview.js     the class: queue, previews, upload
  core/
    files.js            magic-number identification
    validate.js         limits and the accept/refuse decision
    uploader.js         XHR upload with progress and cancellation
    i18n.js             dictionary lookup, plural rules, fallback
    theme.js            host colours, fonts and metrics
    format.js           byte formatting
  locales/            en, uk, es, de, fr — one plain object each
  ui/dom.js           element building with no innerHTML escape hatch
server/             the back end
  handler.js          the routes and the multipart reading
  upload-service.js   storing: sniffing, limits, temp file, atomic rename
  safe-name.js        names and containment
  sniff.js            the same identification, server side
  http.js             the small router it runs on; no framework
types/              hand-written .d.ts, checked by `npm run typecheck`
demo/               the demonstration page
test/               tests
```

---

## Обмеження

- Тільки зображення. Таблиця розпізнавання знає десять форматів; решта відхиляється
  свідомо.
- Перегляд — це `background-image` на div, тож анімований GIF або WebP анімується в плитці
  так, як вирішить браузер; кадри не витягуються.
- Жодної обробки зображень: ні масштабування, ні перекодування, ні очищення EXIF.
- `maxPixels` захищає перегляд, а не сервер: щоб обмежити розміри на сервері, там теж
  треба декодувати, а для цього потрібна бібліотека зображень, від якої пакет не залежить.
- Черга тримається в прихованому input через `DataTransfer`; його підтримують усі сучасні
  браузери, але запасного шляху немає — без нього файли не поїдуть зі звичайною формою.
- HEIC і AVIF розпізнаються й завантажуються, але браузер, який їх не декодує, покаже
  порожню плитку; перетворення на сервері немає.
- Завантаження — один запит на всю чергу. Розбиття на частини немає, тож велика черга на
  поганому зв'язку — це «усе або нічого».
- Віджет використовує container queries і `:has()` — потрібен браузер 2023 року або новіший.
- Node 18+.

## Ліцензія

MIT © Mykhailo Kravtsov.
