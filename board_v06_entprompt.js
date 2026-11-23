// Prompt templates for entourage sheets ("점경"), written for this tool in KO / FR / EN. Pure module (no DOM).
// The user pastes the text into an image generator of their choice (e.g. the Gemini app); nothing is sent from here.

export const PROMPT_LANGS = ["ko", "fr", "en"];
export const PROMPT_KINDS = ["people", "trees", "street", "furniture", "building"];
export const PROMPT_STYLES = ["pen", "flat"];

// what each kind lists (the order of the sheet); `n` default count = items.length
const ITEMS = {
  people: {
    ko: ["서 있는 사람", "걷는 사람", "앉은 사람", "아이", "자전거를 탄 사람", "휠체어를 탄 사람"],
    fr: ["personne debout", "personne qui marche", "personne assise", "enfant", "cycliste", "personne en fauteuil roulant"],
    en: ["standing person", "walking person", "seated person", "child", "person on a bicycle", "person in a wheelchair"]
  },
  trees: {
    ko: ["큰 활엽수", "작은 활엽수", "침엽수", "가로수", "겨울 나목", "나무 수관 평면(위에서 본 모습)"],
    fr: ["grand arbre feuillu", "petit arbre feuillu", "conifère", "arbre d'alignement", "arbre nu en hiver", "couronne d'arbre en plan (vue du dessus)"],
    en: ["large broadleaf tree", "small broadleaf tree", "conifer", "street tree", "bare winter tree", "tree crown in plan (seen from above)"]
  },
  street: {
    ko: ["벤치", "가로등", "자전거 거치대", "승용차"],
    fr: ["banc", "lampadaire", "range-vélos", "voiture"],
    en: ["bench", "street lamp", "bicycle rack", "car"]
  },
  furniture: {
    ko: ["소파", "식탁과 의자", "책장"],
    fr: ["canapé", "table à manger avec chaises", "bibliothèque"],
    en: ["sofa", "dining table with chairs", "bookcase"]
  },
  building: {
    ko: ["파리 오스만 양식 건물 입면", "파리 근교 공동주택 입면"],
    fr: ["façade d'immeuble haussmannien parisien", "façade d'immeuble collectif de banlieue parisienne"],
    en: ["Parisian Haussmann building facade", "Paris-suburb apartment block facade"]
  }
};

const KIND_NAME = {
  people: { ko: "사람", fr: "personnages", en: "people" },
  trees: { ko: "나무", fr: "arbres", en: "trees" },
  street: { ko: "거리 시설", fr: "mobilier urbain", en: "street objects" },
  furniture: { ko: "가구", fr: "meubles", en: "furniture" },
  building: { ko: "배경 건물", fr: "bâtiments de fond", en: "background buildings" }
};

// building sheets are facades seen from the front; everything else is a side view (trees in plan are the one listed exception)
const VIEW = {
  side: {
    ko: "모두 옆모습(정면에 가까운 측면 입면)으로, 서로 같은 축척으로",
    fr: "tous de profil (élévation latérale), à la même échelle",
    en: "all in side elevation, drawn at the same scale"
  },
  front: {
    ko: "모두 정면 입면으로, 서로 같은 축척으로",
    fr: "tous en élévation frontale, à la même échelle",
    en: "all in frontal elevation, drawn at the same scale"
  }
};

const STYLE = {
  pen: {
    ko: "펜 선화: 흰 바탕에 검은 선만 사용합니다. 면 채움, 음영, 회색, 바닥선, 그림자, 글자, 숫자, 테두리 상자를 넣지 않습니다. 각 그림은 선이 닫힌 하나의 형태로 그립니다.",
    fr: "dessin au trait à la plume : uniquement des lignes noires sur fond blanc. Pas de remplissage, d'ombre, de gris, de ligne de sol, de texte, de chiffre ni de cadre. Chaque figure est un contour fermé.",
    en: "pen line drawing: only black lines on a white background. No fills, shading, grey tones, ground line, shadows, text, numbers or frames. Each figure is one closed outline."
  },
  flat: {
    ko: "플랫 면 그림: 외곽선 없이 단색 면 2~3톤으로만 칠합니다. 밝은 부분도 흰색 대신 연한 색을 씁니다(배경 흰색과 구분되도록). 그라데이션, 질감, 바닥선, 그림자, 글자는 넣지 않습니다.",
    fr: "illustration en aplats : pas de contour, seulement 2 à 3 tons de couleur unie. Les parties claires utilisent une couleur pâle et jamais du blanc (pour rester distinctes du fond blanc). Pas de dégradé, de texture, de ligne de sol, d'ombre ni de texte.",
    en: "flat colour illustration: no outlines, only 2 to 3 flat tones per figure. Light areas use a pale colour, never white, so they stay distinct from the white background. No gradients, textures, ground line, shadows or text."
  }
};

const FRAME = {
  ko: (n, what, view, gapTxt) => `흰 바탕의 이미지 한 장에 ${what} ${n}개를 한 줄 또는 두 줄로 나란히 그려 주세요. ${view}. ${n}개 모두 겹치지 않게, 서로 넉넉히 띄워서(그림 폭의 절반 이상) 그립니다. 개수는 정확히 ${n}개입니다. ${gapTxt}`,
  fr: (n, what, view, gapTxt) => `Sur une seule image à fond blanc, dessine ${n} ${what} côte à côte, sur une ou deux rangées. ${view}. Les ${n} figures ne se touchent ni ne se chevauchent pas : laisse un large espace entre elles (au moins la moitié de leur largeur). Le nombre est exactement ${n}. ${gapTxt}`,
  en: (n, what, view, gapTxt) => `On a single image with a white background, draw ${n} ${what} side by side in one or two rows. ${view}. None of the ${n} figures may touch or overlap; leave generous space between them (at least half a figure width). The count is exactly ${n}. ${gapTxt}`
};
const STYLE_LEAD = { ko: "그림 방식 — ", fr: "Style — ", en: "Style: " };
const END = {
  ko: "각 그림은 바닥(발·줄기 아래)이 같은 선상에 오지 않아도 되지만, 그림 안에서 잘리지 않게 전체가 보여야 합니다. 배경에는 하늘, 산, 풍경을 넣지 않습니다.",
  fr: "Chaque figure doit être entière, sans être coupée par le bord de l'image ; le sol n'a pas besoin d'être aligné d'une figure à l'autre. Pas de ciel, de montagne ni de paysage en arrière-plan.",
  en: "Each figure must be shown in full, not cut by the image edge; their ground points do not need to line up. No sky, mountains or landscape in the background."
};
const GEMINI = {
  ko: "사용법: Gemini 앱(또는 쓰시는 이미지 생성 도구)에 이 문장을 붙여 넣어 이미지를 만든 뒤, '시트 자르기' 탭에 그 이미지를 넣으세요. 만들어진 이미지는 사용한 서비스의 약관을 따릅니다.",
  fr: "Mode d'emploi : colle ce texte dans l'application Gemini (ou l'outil d'image que tu utilises), puis dépose l'image obtenue dans l'onglet « Découper une planche ». Les images générées suivent les conditions du service utilisé.",
  en: "How to use: paste this text into the Gemini app (or the image tool you use), then drop the resulting image into the \"Cut a sheet\" tab. Generated images follow the terms of the service you used."
};

export const itemsOf = (kind, lang) => (ITEMS[kind] || ITEMS.people)[lang] || ITEMS[kind].en;
export const defaultCount = kind => (ITEMS[kind] || ITEMS.people).en.length;
export const kindName = (kind, lang) => KIND_NAME[kind]?.[lang] || kind;
export const geminiNote = lang => GEMINI[lang] || GEMINI.en;

/**
 * Build the prompt text. opt: { kind, style, lang, n } ; n = number of figures (1..24).
 * If n is larger than the list, the list repeats with variations asked for; if smaller, the list is cut.
 */
export function buildPrompt({ kind = "people", style = "pen", lang = "ko", n } = {}) {
  if (!PROMPT_KINDS.includes(kind)) kind = "people";
  if (!PROMPT_STYLES.includes(style)) style = "pen";
  if (!PROMPT_LANGS.includes(lang)) lang = "en";
  const items = itemsOf(kind, lang), count = Math.min(24, Math.max(1, Math.round(Number(n) || items.length)));
  const view = (kind === "building" ? VIEW.front : VIEW.side)[lang];
  const list = Array.from({ length: count }, (_, i) => `${i + 1}. ${items[i % items.length]}${i >= items.length ? ({ ko: " (다른 모습)", fr: " (autre variante)", en: " (another variant)" })[lang] : ""}`).join("\n");
  const head = FRAME[lang](count, kindName(kind, lang), view, "");
  return `${head}\n${list}\n${STYLE_LEAD[lang]}${STYLE[style][lang]}\n${END[lang]}`;
}
