// Atelier 4·2 site i18n (FR / KO). No dependencies. ES module (shared singleton) + globalThis.a42i18n for classic scripts.
//   t(key, vars)      "{name}" interpolation, "{n, plural, one {…} other {…}}"; a missing key returns the Korean source and warns once.
//   setLang(l)        stores the choice, sets <html lang>, re-applies [data-i18n] / [data-i18n-attr], fires "a42:lang".
//   fmtDate(d)        Intl.DateTimeFormat for the current language (FR 22/11/2026, KO 2026-11-22).
export const LANGS = ["fr", "ko"];
const KEY = "a42.lang";
const SRC = "ko";   // the source language: its strings are the fallback for any missing key
const IS_NODE = typeof window === "undefined";   // node tests: catalogs from disk, Korean unless A42_LANG says otherwise
let lang = IS_NODE ? (globalThis.process?.env?.A42_LANG === "fr" ? "fr" : "ko") : detect(), cats = { ko: {}, fr: {} }, loaded = false;
const warned = new Set();
function detect() {
  try { const s = localStorage.getItem(KEY); if (LANGS.includes(s)) return s; } catch { /* private mode */ }
  for (const l of (typeof navigator !== "undefined" && navigator.languages) || []) {
    const p = String(l).slice(0, 2).toLowerCase();
    if (LANGS.includes(p)) return p;
  }
  return "fr";
}
export const getLang = () => lang;
const warnOnce = k => { if (!warned.has(k)) { warned.add(k); console.warn(`[i18n] missing key: ${k}`); } };
function plural(body, vars) {   // "{n, plural, one {1 page} other {{n} pages}}" (brace-balanced; the rule is the language's own for one/other)
  return body.replace(/\{(\w+),\s*plural,\s*((?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*)\}/g, (_, name, rules) => {
    const n = Number(vars?.[name]), m = {};
    for (const r of rules.matchAll(/(\w+)\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g)) m[r[1]] = r[2];
    const one = lang === "fr" ? (n === 0 || n === 1) : n === 1;
    return (m[n === 0 && m.zero ? "zero" : one ? "one" : "other"] ?? m.other ?? "").replace(/\{(\w+)\}/g, (x, k) => vars?.[k] ?? x);
  });
}
export function t(key, vars) {
  let s = cats[lang]?.[key];
  if (typeof s !== "string" || s.startsWith("__TODO__")) { const ko = cats[SRC]?.[key]; if (typeof ko !== "string") { warnOnce(key); return key; } if (typeof s !== "string") warnOnce(key); s = ko.replace(/^__TODO__\s*/, ""); }
  if (s.includes("plural")) s = plural(s, vars);
  return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s;
}
export function fmtDate(d, opts) {
  const dt = d instanceof Date ? d : new Date(String(d).length === 10 ? `${d}T12:00:00` : d);
  if (Number.isNaN(dt.getTime())) return "";
  if (lang === "ko") return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
  return new Intl.DateTimeFormat("fr-FR", opts || { day: "2-digit", month: "2-digit", year: "numeric" }).format(dt);
}
export const fmtNumber = (n, opts) => new Intl.NumberFormat(lang === "fr" ? "fr-FR" : "ko-KR", opts).format(n);
export function apply(root = document) {
  for (const e of root.querySelectorAll("[data-i18n]")) e.textContent = t(e.dataset.i18n);
  for (const e of root.querySelectorAll("[data-i18n-html]")) e.innerHTML = t(e.dataset.i18nHtml);   // catalogs are first-party markup (br, a, strong, kbd)
  for (const e of root.querySelectorAll("[data-i18n-attr]")) for (const pair of e.dataset.i18nAttr.split(";")) { const [a, k] = pair.split(":").map(x => x.trim()); if (a && k) e.setAttribute(a, t(k)); }
  for (const b of root.querySelectorAll("[data-lang]")) { const on = b.dataset.lang === lang; b.setAttribute("aria-pressed", String(on)); }
}
export function setLang(l) {
  if (!LANGS.includes(l)) return;
  lang = l;
  try { localStorage.setItem(KEY, l); } catch { /* ignore */ }
  document.documentElement.lang = l;
  apply();
  document.dispatchEvent(new CustomEvent("a42:lang", { detail: { lang: l } }));
}
export const onLang = fn => { document.addEventListener("a42:lang", e => fn(e.detail.lang)); };
const load = async l => { try { const r = await fetch(`./i18n/${l}.json?v=20261122i`); if (r.ok) cats[l] = await r.json(); } catch (e) { console.warn(`[i18n] cannot load ${l}.json`, e); } };
function ready() { document.documentElement.setAttribute("data-i18n-ready", ""); }
export const loadedPromise = IS_NODE ? (async () => {
  const fs = await import("node:fs");
  for (const l of LANGS) cats[l] = JSON.parse(fs.readFileSync(new URL(`./i18n/${l}.json`, import.meta.url), "utf8"));
  loaded = true;
})() : (async () => {
  setTimeout(ready, 1500);   // safety: never leave the page hidden
  await Promise.all([load("ko"), load("fr")]);
  loaded = true;
  document.documentElement.lang = lang;
  const wire = () => {
    for (const b of document.querySelectorAll("[data-lang]")) b.addEventListener("click", () => setLang(b.dataset.lang));
    apply(); ready();
    document.dispatchEvent(new CustomEvent("a42:lang", { detail: { lang } }));
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire, { once: true }); else wire();
})();
if (IS_NODE) await loadedPromise;
globalThis.a42i18n = { t, setLang, getLang, fmtDate, fmtNumber, apply, onLang, LANGS, get loaded() { return loaded; } };
