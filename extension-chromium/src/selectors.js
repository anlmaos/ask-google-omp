/**
 * Google AI Mode DOM selectors and constants.
 *
 * These are isolated here so we can update them as Google's markup shifts
 * without touching the parsing logic. Ported from the google-ai-mode-mcp
 * reference repo (src/constants/language-constants.ts).
 *
 * Loaded as a classic script BEFORE content.js (see manifest.json content
 * scripts), so we attach everything to a global namespace.
 */

globalThis.ANIMA_SELECTORS = {
 // Citation button selectors - multilanguage fallback chain.
 CITATION_SELECTORS: [
  // English
  '[aria-label="View related links"]',
  '[aria-label*="Related links"]',
  '[aria-label*="Sources"]',
  // German
  '[aria-label="Zugehörige Links anzeigen"]',
  '[aria-label*="Zugehörige Links"]',
  '[aria-label*="Quellen"]',
  // French
  '[aria-label*="Liens associés"]',
  '[aria-label*="Sources"]',
  // Spanish
  '[aria-label*="Enlaces relacionados"]',
  '[aria-label*="Fuentes"]',
  // Dutch
  '[aria-label*="Gerelateerde links"]',
  '[aria-label*="Bronnen"]',
  // Italian
  '[aria-label*="Link correlati"]',
  '[aria-label*="Fonti"]',
  // Russian (RU) — observed live: aria-label="Посмотреть ссылки по теме"
  //   ("View related links"). These substrings are specific enough not to
  //   false-match other UI chrome; case-insensitive i-flag for safety.
  //   RU: "Посмотреть ссылки по теме" (exact observed phrase)
  '[aria-label*="Посмотреть ссылки по теме" i]',
  //   RU: "ссылки по теме" (substring, robust to "View"/"Show" prefix variants)
  '[aria-label*="ссылки по теме" i]',
  //   RU: "Посмотреть ссылки" (shorter, robust if Google trims the phrase)
  '[aria-label*="Посмотреть ссылки" i]',
  // Generic fallback (case-insensitive) — English/German "links"
  'button[aria-label*="links" i]',
  // Language-neutral fallback (HARDENING).
  // Google AI Mode marks every citation "...links on the topic" button with
  // data-amic="true" and a unique data-icl-uuid, regardless of locale. If a
  // future locale (e.g. JA/ZH/KO/AR) lacks an aria-label entry above, this
  // still finds the buttons. Confirmed in live RU sample: data-amic="true"
  // appears ONLY on citation buttons (8/8), never on other UI chrome.
  'button[data-amic="true"]',
 ],

 // AI completion - button-based detection (language independent).
 AI_COMPLETION_BUTTON_SVG: 'button svg[viewBox="3 3 18 18"]',
 AI_COMPLETION_BUTTON_ARIA: '[aria-label*="feedback" i]',
 AI_COMPLETION_TIMEOUT: 15000,
 OVERALL_COMPLETION_TIMEOUT: 15000,
 SCROLL_STABILITY_MS: 800,
 SCROLL_POLL_MS: 200,
 // Text-based completion indicators (multilanguage fallback).
 AI_COMPLETION_TEXT_INDICATORS: [
  "AI-generated",
  "AI Overview",
  "Generative AI is experimental",
  "KI-Antworten",
  "KI-generiert",
  "Generative KI",
  "AI-gegenereerd",
  "AI-overzicht",
  "Las respuestas de la IA",
  "Resumen de IA",
  "Información general de IA",
  "Réponses IA",
  "Aperçu de l'IA",
  "Vue d'ensemble de l'IA",
  "Risposte IA",
  "Panoramica IA",
  "Panoramica dell'IA",
 ],

 // Disclaimer cutoff markers - everything after these gets stripped.
 CUTOFF_MARKERS: [
  "KI-Antworten können Fehler enthalten",
  "Öffentlicher Link wird erstellt",
  "AI-generated answers may contain mistakes",
  "AI can make mistakes",
  "Generative AI is experimental",
  "AI overviews are experimental",
  "AI-reacties kunnen fouten bevatten",
  "Las respuestas de la IA pueden contener errores",
  "pueden contener errores",
  "Más información",
  "Les réponses de l'IA peuvent contenir des erreurs",
  "peuvent contenir des erreurs",
  "Plus d'informations",
  "Le risposte dell'IA possono contenere errori",
  "possono contenere errori",
  "Ulteriori informazioni",
 ],

 // AI Mode not available (region/language restrictions).
 AI_MODE_NOT_AVAILABLE: [
  "Le Mode IA n'est pas disponible dans votre pays ou votre langue",
  "Mode IA n'est pas disponible",
  "Découvrez le Mode IA",
  "AI Mode is not available in your country or language",
  "AI Mode isn't available",
  "Der KI-Modus ist in Ihrem Land oder Ihrer Sprache nicht verfügbar",
  "KI-Modus ist nicht verfügbar",
  "El modo de IA no está disponible en tu país o idioma",
  "La modalità IA non è disponibile nel tuo Paese o nella tua lingua",
  "AI-modus is niet beschikbaar in uw land of taal",
 ],

 // DOM containers for the AI Mode layout.
 MAIN_CONTAINER: '[data-container-id="main-col"]',
 SIDE_CONTAINER: '[data-container-id="rhs-col"]',

 // Google internal domains to skip when extracting sources.
 SKIP_DOMAINS: [
  "google.com",
  "google.de",
  "gstatic.com",
  "support.google.com",
 ],
};
