/* Imorat site settings.
   IMORAT_API — address of the Imorat server (folder server/ in this repo), for example "https://api.imorat.uz".
   Leave it empty to run the site as a demo where data stays in the visitor's browser. */
window.IMORAT_API = "";
/* true on the real website: enables the installable app (service worker, push notifications) */
window.IMORAT_SITE = true;
/* Public address of this website. The app uses it for the legal pages and the way back from the bank page;
   set it explicitly — it is never guessed from the API address. */
window.IMORAT_SITE_URL = "https://usmonovm7777-crypto.github.io/Imorat/";
/* Yandex Maps key («JavaScript API и HTTP Геокодер» in the Yandex developer dashboard). With it the checkout shows the real
   Yandex map with address suggestions; empty = OpenStreetMap tiles and address search through the server / Nominatim. */
window.IMORAT_YMAPS_KEY = "";
