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

## Что подключить на сервере (следующий этап)

| Функция | Сервис |
|---|---|
| Вход через Google | Google Identity Services (OAuth client ID) |
| Вход через Apple | Sign in with Apple (нужен Apple Developer Program) |
| SMS-коды | SMS-шлюз Узбекистана: Eskiz или Play Mobile |
| Доставка | API Яндекс Доставки для бизнеса (договор и токен) |
| Оплата | Click, Payme, Uzum (мерчант-API), рассрочка через партнёра |
| Usta AI | Anthropic API через свой сервер (ключ не хранится в браузере) |
| Каталог, заказы, продавцы | База данных (например PostgreSQL) и админка магазинов |

Все ключи и токены держите только на сервере, в браузер их не передавайте.
