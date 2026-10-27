# Imorat — маркетплейс строительных магазинов Узбекистана

Прототип сайта: каталог из 347 товаров девяти магазинов Ташкента с 3D-фото, сравнение цен,
Usta AI, калькуляторы ремонта, вход через Google, Apple и номер телефона, корзина по магазинам,
VIP-доставка, рассрочка, кабинет продавца и доставка через Яндекс.

Сейчас это **статический сайт**: все данные демонстрационные и хранятся в браузере
пользователя. Сервер (бэкенд) — следующий этап, план ниже.

## Структура

| Путь | Что это |
|---|---|
| `index.html` | Готовый сайт (собирается из `src/page.html`) |
| `img/` | 3D-фото товаров (WebP, 600×600) |
| `src/page.html` | Исходник страницы: стили, разметка и JavaScript |
| `tools/build_site.py` | Собирает `index.html` из исходника |
| `tools/render/` | Собственный 3D-рендерер фото товаров (WebGL) |
| `config.js` | Адрес сервера для сайта (`IMORAT_API`) |
| `server/` | Сервер API (Node.js 22, SQLite, Docker) |

## Запустить у себя

```bash
python3 tools/build_site.py
python3 -m http.server 8000
# открыть http://localhost:8000
```

## Опубликовать на GitHub Pages

1. Settings → Pages → Source: **Deploy from a branch**, ветка `main`, папка `/ (root)`.
2. Через 1–2 минуты сайт откроется по адресу `https://<ваш-логин>.github.io/<репозиторий>/`.
3. Свой домен (например `imorat.uz`): Settings → Pages → Custom domain, и CNAME-запись у регистратора.

## Перерисовать фото товаров

Нужен Python 3 с Playwright и Pillow:

```bash
pip install playwright pillow && playwright install chromium
python3 tools/render/run.py img all 760 600            # 96 базовых товаров
python3 tools/render/variants.py /tmp/v.json /tmp/r.json # данные вариантов
python3 tools/render/run_named.py /tmp/r.json img 720 600
```

Модели товаров описаны в `tools/render/render.html`, цвета и этикетки — в `specs.py` и `variants.py`.

## Сервер

Папка [`server/`](server/README.md) — API на Node.js 22 без зависимостей: вход по SMS (Eskiz), Google и Apple,
заказы с серверными ценами и остатками, Яндекс Доставка, Usta AI, регистрация магазинов с модерацией и кабинет продавца.

Сайт подключается к серверу через `config.js`:

```js
window.IMORAT_API = "https://api.imorat.uz"; // пусто — демо-режим, данные только в браузере
```

Регистрация: покупатель, мастер/прораб (опт −3%) или «Хочу добавить свой магазин» — анкета магазина
(название, описание, категории, телефон, Telegram, часы, адрес, ориентир и точка на карте: автоматически по GPS
или вручную на карте Ташкента). Паспортные данные не запрашиваются.

## Следующий этап
- Оплата Click / Payme / Uzum.
- Заявки и статусы через API Яндекс Доставки.
- Мобильное приложение на том же API.
