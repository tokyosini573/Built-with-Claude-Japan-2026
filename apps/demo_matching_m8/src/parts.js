// 共通部品: アプリ名の差し込みと、イラストのアバター生成（実在人物の写真は使わない）
(function () {
  const B = window.BRAND || {};
  document.querySelectorAll("[data-brand]").forEach((el) => {
    el.textContent = B[el.dataset.brand] ?? el.textContent;
  });

  // 輪郭線のある人物イラスト（背景は円）。seed で髪型・色を変える。
  const skins = ["#f3d6bf", "#eac3a3", "#f6dfcc", "#e2b48f"];
  const hairs = ["#3b2a22", "#5a3d2b", "#231a16", "#7a5236", "#4a3a33"];
  const bgs = ["#dfe3f5", "#fde2da", "#e9e3f3", "#d9eef2", "#f7e9d3", "#e4ecf8"];
  const tops = ["#4757a6", "#ea7a62", "#8a7fb8", "#5aa3b0", "#d99a4e", "#6d7c96"];
  function avatar(seed, kind) {
    const s = skins[seed % 4], h = hairs[seed % 5], bg = bgs[seed % 6], t = tops[(seed * 7) % 6];
    const long = kind === "f";
    const hairBack = long
      ? `<path d="M30 58 Q28 26 60 24 Q92 26 90 58 L92 96 Q60 104 28 96 Z" fill="${h}"/>`
      : "";
    const hairFront = long
      ? `<path d="M36 50 Q40 28 60 28 Q82 28 86 52 Q72 40 56 42 Q44 44 36 50 Z" fill="${h}"/>`
      : (seed % 2
        ? `<path d="M37 52 Q36 28 60 27 Q85 28 84 52 Q78 38 60 38 Q44 38 37 52 Z" fill="${h}"/>`
        : `<path d="M36 50 Q38 26 62 27 Q86 30 84 50 Q70 36 50 42 Q42 44 36 50 Z" fill="${h}"/>`);
    return `<svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg">
      <rect width="120" height="120" fill="#ffffff"/><circle cx="60" cy="60" r="56" fill="${bg}"/>
      ${hairBack}
      <path d="M22 120 Q24 90 60 88 Q96 90 98 120 Z" fill="${t}" stroke="#1f2335" stroke-width="2"/>
      <rect x="52" y="74" width="16" height="16" rx="6" fill="${s}"/>
      <ellipse cx="60" cy="55" rx="23" ry="25" fill="${s}" stroke="#1f2335" stroke-width="2"/>
      ${hairFront}
      <path d="M47 57 Q51 54 55 57" stroke="#1f2335" stroke-width="2" fill="none" stroke-linecap="round"/><path d="M65 57 Q69 54 73 57" stroke="#1f2335" stroke-width="2" fill="none" stroke-linecap="round"/><circle cx="45" cy="64" r="3" fill="#f4a9a0" opacity=".6"/><circle cx="75" cy="64" r="3" fill="#f4a9a0" opacity=".6"/>
      <path d="M54 67 Q60 71 66 67" stroke="#a9654f" stroke-width="2" fill="none" stroke-linecap="round"/>
    </svg>`;
  }
  document.querySelectorAll(".av[data-seed]").forEach((el) => {
    el.innerHTML = avatar(Number(el.dataset.seed), el.dataset.kind || "m");
  });
  window.__ready = true;
})();
