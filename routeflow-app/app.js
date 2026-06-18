// app.js — render screens, wire role tabs + tweaks + offline banner

function renderPhones(containerId, list) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = list
    .map(
      ([label, sub, body]) => `
    <div class="phone-slot">
      <div class="phone-label"><b>${label}</b> · ${sub}</div>
      <div class="phone">
        <div class="dynamic-island"></div>
        ${body}
      </div>
    </div>
  `,
    )
    .join("");
}

renderPhones("driver-phones", window.driverPhones || []);
renderPhones("operator-phones", window.operatorPhones || []);
renderPhones("shared-phones", window.sharedPhones || []);

/* Role switcher */
function setRole(role) {
  ["driver", "operator", "shared"].forEach((r) => {
    const sec = document.getElementById(r + "-screens");
    if (sec) sec.style.display = r === role ? "" : "none";
  });
  document.querySelectorAll(".role-tab").forEach((t) => {
    t.classList.toggle("active", t.dataset.role === role);
  });
  try {
    localStorage.setItem("rf_role", role);
  } catch (e) {}
}
try {
  const saved = localStorage.getItem("rf_role");
  if (saved) setRole(saved);
} catch (e) {}

/* ──────── TWEAKS ──────── */
const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/ {
  brand: "#0B6E6B",
  theme: "light",
  density: "default",
  offline: "online",
}; /*EDITMODE-END*/

let tweakState = { ...TWEAK_DEFAULTS };
try {
  const saved = JSON.parse(localStorage.getItem("rf_tweaks") || "{}");
  tweakState = { ...tweakState, ...saved };
} catch (e) {}

function applyTweaks() {
  const root = document.documentElement;
  // Brand
  const b = tweakState.brand;
  root.style.setProperty("--brand", b);
  root.style.setProperty("--brand-wash", hexA(b, 0.1));
  root.style.setProperty("--brand-wash-strong", hexA(b, 0.16));
  root.style.setProperty(
    "--brand-gradient",
    `linear-gradient(135deg, ${b} 0%, ${shade(b, -0.12)} 55%, ${shade(b, -0.28)} 100%)`,
  );
  // Theme
  root.setAttribute("data-theme", tweakState.theme);
  const modeChip = document.getElementById("mode-chip");
  if (modeChip) modeChip.textContent = tweakState.theme === "dark" ? "Dark mode" : "Light mode";
  // Density
  root.setAttribute("data-density", tweakState.density);
  // Offline: toggle body class (screens opt-in via .offline-banner visibility if needed)
  document.body.classList.toggle("rf-offline", tweakState.offline === "offline");

  // Reflect active chips
  document.querySelectorAll(".tweaks-panel .tweak-options").forEach((group) => {
    const key = group.id.replace("tw-", "");
    group.querySelectorAll(".tweak-chip").forEach((chip) => {
      chip.classList.toggle("active", chip.dataset.val === String(tweakState[key]));
    });
  });
  try {
    localStorage.setItem("rf_tweaks", JSON.stringify(tweakState));
  } catch (e) {}
}

function hexA(hex, a) {
  const m = hex.replace("#", "");
  const r = parseInt(m.slice(0, 2), 16),
    g = parseInt(m.slice(2, 4), 16),
    b = parseInt(m.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}
function shade(hex, pct) {
  const m = hex.replace("#", "");
  let r = parseInt(m.slice(0, 2), 16),
    g = parseInt(m.slice(2, 4), 16),
    b = parseInt(m.slice(4, 6), 16);
  r = Math.max(0, Math.min(255, Math.round(r + 255 * pct)));
  g = Math.max(0, Math.min(255, Math.round(g + 255 * pct)));
  b = Math.max(0, Math.min(255, Math.round(b + 255 * pct)));
  return `rgb(${r}, ${g}, ${b})`;
}

document.querySelectorAll(".tweaks-panel .tweak-options").forEach((group) => {
  const key = group.id.replace("tw-", "");
  group.querySelectorAll(".tweak-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      tweakState[key] = chip.dataset.val;
      applyTweaks();
      // Persist via host
      try {
        window.parent.postMessage(
          { type: "__edit_mode_set_keys", edits: { [key]: chip.dataset.val } },
          "*",
        );
      } catch (e) {}
    });
  });
});

applyTweaks();

/* ──────── EDIT MODE ──────── */
window.addEventListener("message", (e) => {
  if (!e.data || typeof e.data !== "object") return;
  if (e.data.type === "__activate_edit_mode") {
    document.getElementById("tweaks").classList.add("open");
  } else if (e.data.type === "__deactivate_edit_mode") {
    document.getElementById("tweaks").classList.remove("open");
  }
});

function toggleTweaks(open) {
  document.getElementById("tweaks").classList.toggle("open", open);
}
window.toggleTweaks = toggleTweaks;
window.setRole = setRole;

try {
  window.parent.postMessage({ type: "__edit_mode_available" }, "*");
} catch (e) {}
