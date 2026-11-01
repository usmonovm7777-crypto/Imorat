/* shows the section for ?lang=ru|uz|en (default ru), keeps the language switch links in step */
(function () {
  var m = location.search.match(/[?&]lang=(ru|uz|en)/), lang = m ? m[1] : "ru";
  document.querySelectorAll("[data-lang]").forEach(function (el) { el.classList.toggle("on", el.getAttribute("data-lang") === lang); });
  document.querySelectorAll(".langs a").forEach(function (a) { a.classList.toggle("on", a.getAttribute("data-l") === lang); });
  document.documentElement.lang = lang;
})();
