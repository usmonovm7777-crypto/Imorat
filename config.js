/* Imorat site settings.
   IMORAT_API — address of the Imorat server (folder server/ in this repo), for example "https://api.imorat.uz".
   Leave it empty to run the site as a demo where data stays in the visitor's browser. */
window.IMORAT_API = "";
/* true on the real website: enables the installable app (service worker, push notifications) */
window.IMORAT_SITE = true;
/* Yandex Maps key («JavaScript API и HTTP Геокодер» in the Yandex developer dashboard). With it the checkout shows the real
   Yandex map with address suggestions; empty = OpenStreetMap tiles and address search through the server / Nominatim. */
window.IMORAT_YMAPS_KEY = "";
