const slides = Array.from(document.querySelectorAll(".background-slide"));
const dots = Array.from(document.querySelectorAll(".wallpaper-dot"));

let activeIndex = 0;
let rotateTimer = null;

function showSlide(index) {
  activeIndex = index;
  slides.forEach((slide, i) => slide.classList.toggle("is-active", i === index));
  dots.forEach((dot, i) => {
    dot.classList.toggle("is-active", i === index);
    dot.setAttribute("aria-pressed", String(i === index));
  });
}

function startRotation() {
  clearInterval(rotateTimer);
  rotateTimer = setInterval(() => {
    showSlide((activeIndex + 1) % slides.length);
  }, 9000);
}

dots.forEach((dot) => {
  dot.addEventListener("click", () => {
    showSlide(Number(dot.dataset.wallpaperIndex));
    startRotation();
  });
});

startRotation();
