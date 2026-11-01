/* shows the section for ?lang=ru|uz|en (default ru), keeps the language switch links in step */
(function () {
  var m = location.search.match(/[?&]lang=(ru|uz|en)/), lang = m ? m[1] : "ru";
  document.querySelectorAll("[data-lang]").forEach(function (el) { el.classList.toggle("on", el.getAttribute("data-lang") === lang); });
  document.querySelectorAll(".langs a").forEach(function (a) { a.classList.toggle("on", a.getAttribute("data-l") === lang); });
  document.documentElement.lang = lang;
  var names = { privacy: ["Политика конфиденциальности", "Maxfiylik siyosati", "Privacy policy"], terms: ["Условия использования", "Foydalanish shartlari", "Terms of use"], "delete-account": ["Удаление аккаунта", "Akkauntni o‘chirish", "Delete account"] };
  document.querySelectorAll("nav.docs a[data-doc]").forEach(function (a) { var n = names[a.getAttribute("data-doc")]; if (n) a.textContent = n[{ ru: 0, uz: 1, en: 2 }[lang]]; a.setAttribute("href", a.getAttribute("data-doc") + ".html?lang=" + lang); });
})();
