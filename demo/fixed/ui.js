const menu = document.querySelector('.menu-btn');
const nav = document.getElementById('nav');
menu.addEventListener('click', () => {
  const open = nav.classList.toggle('open');
  menu.setAttribute('aria-expanded', String(open));
});
nav.addEventListener('click', (e) => {
  if (e.target.closest('a')) { nav.classList.remove('open'); menu.setAttribute('aria-expanded', 'false'); }
});
for (const b of document.querySelectorAll('[data-open]')) {
  b.addEventListener('click', () => document.getElementById(b.dataset.open).showModal());
}
