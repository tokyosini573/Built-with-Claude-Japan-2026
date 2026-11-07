// 共通部品: アプリ名の差し込みと、イラストのアバター生成（実在人物の写真は使わない）
(function () {
  const B = window.BRAND || {};
  document.querySelectorAll("[data-brand]").forEach((el) => {
    el.textContent = B[el.dataset.brand] ?? el.textContent;
  });

  // シンプルな線と面の人物イラスト。seed で髪型・色を変える。
  const skins = ["#f3d6bf", "#eac3a3", "#f6dfcc", "#e2b48f"];
  const hairs = ["#3b2a22", "#5a3d2b", "#231a16", "#7a5236", "#4a3a33"];
  const bgs = ["#d7e8e0", "#f6e3bf", "#e8dccd", "#dfe4ee", "#f2d9cf", "#e1ecd5"];
  const tops = ["#2f7d6c", "#e3a83b", "#7f8fa6", "#c97b63", "#5d6d63", "#b9a27c"];
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
      <rect width="120" height="120" fill="${bg}"/>
      ${hairBack}
      <path d="M22 120 Q24 90 60 88 Q96 90 98 120 Z" fill="${t}"/>
      <rect x="52" y="74" width="16" height="16" rx="6" fill="${s}"/>
      <ellipse cx="60" cy="55" rx="23" ry="25" fill="${s}"/>
      ${hairFront}
      <circle cx="51" cy="57" r="2.2" fill="#2b2420"/><circle cx="69" cy="57" r="2.2" fill="#2b2420"/>
      <path d="M54 67 Q60 71 66 67" stroke="#a9654f" stroke-width="2" fill="none" stroke-linecap="round"/>
    </svg>`;
  }
  document.querySelectorAll(".av[data-seed]").forEach((el) => {
    el.innerHTML = avatar(Number(el.dataset.seed), el.dataset.kind || "m");
  });
  window.__ready = true;
})();
